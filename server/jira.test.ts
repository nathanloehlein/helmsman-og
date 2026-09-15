import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssueSummary, fetchTriageGroups, fetchApproxCount, fetchOpenBugs, fetchOldestOpenBug, fetchResolvedDurations } from './jira';
import type { JiraConfig } from './config';
import type { JiraIssue } from './types';
import {
  buildOpenBugsJql, buildCreatedSinceJql, buildResolvedSinceJql,
  buildPastSlaJql, buildOldestOpenBugJql, buildResolved90Jql,
} from './config';

const jira: JiraConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: 'token',
  project: 'PROJ',
  assignee: 'bot',
  jql: null,
};

describe('fetchIssueSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the summary on a successful response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ fields: { summary: 'Hello' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBe('Hello');
  });

  it('returns null on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      text: async () => 'not found',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBeNull();
  });
});

function issue(key: string): JiraIssue {
  return {
    key,
    fields: {
      summary: key,
      status: { name: 'Backlog', statusCategory: { key: 'new' } },
      priority: null,
      resolutiondate: null,
    },
  };
}

describe('fetchTriageGroups', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes each group to its JQL and returns the mapped issues', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const jql: string = new URL(url.toString()).searchParams.get('jql') ?? '';
      let issues: JiraIssue[] = [];
      if (jql.includes('IS EMPTY') && jql.includes('"Backlog"')) issues = [issue('B-1')];
      else if (jql.includes('IS EMPTY') && jql.includes('"To Do"')) issues = [issue('T-1'), issue('T-2')];
      else if (jql.includes('statusCategory != Done')) issues = [issue('M-1')];
      return { ok: true, json: async () => ({ issues }) };
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const groups = await fetchTriageGroups(jira, 'Backlog', 'To Do');

    expect(groups.unassignedBacklog.map((i) => i.key)).toEqual(['B-1']);
    expect(groups.unassignedTodo.map((i) => i.key)).toEqual(['T-1', 'T-2']);
    expect(groups.mineOpen.map((i) => i.key)).toEqual(['M-1']);
  });

  it('empties only the failing group and keeps the others', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const jql: string = new URL(url.toString()).searchParams.get('jql') ?? '';
      if (jql.includes('"To Do"')) return { ok: false, text: async () => 'bad status name' };
      const issues: JiraIssue[] = jql.includes('statusCategory != Done') ? [issue('M-1')] : [issue('B-1')];
      return { ok: true, json: async () => ({ issues }) };
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const groups = await fetchTriageGroups(jira, 'Backlog', 'To Do');

    expect(groups.unassignedBacklog.map((i) => i.key)).toEqual(['B-1']);
    expect(groups.unassignedTodo).toEqual([]);
    expect(groups.mineOpen.map((i) => i.key)).toEqual(['M-1']);
  });

  it('throws only when every group fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, text: async () => 'down' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTriageGroups(jira, 'Backlog', 'To Do')).rejects.toThrow();
  });
});

describe('bug JQL builders', () => {
  it('scopes open bugs to a project and excludes done', () => {
    expect(buildOpenBugsJql('AIROBUILD')).toBe(
      'project = "AIROBUILD" AND issuetype = Bug AND statusCategory != Done ORDER BY priority ASC, duedate ASC',
    );
  });
  it('windows created and resolved counts', () => {
    expect(buildCreatedSinceJql('P', 7)).toBe('project = "P" AND issuetype = Bug AND created >= -7d');
    expect(buildResolvedSinceJql('P', 7)).toBe('project = "P" AND issuetype = Bug AND statusCategory = Done AND resolutiondate >= -7d');
  });
  it('flags past-SLA open bugs and oldest open', () => {
    expect(buildPastSlaJql('P')).toBe('project = "P" AND issuetype = Bug AND statusCategory != Done AND duedate < now()');
    expect(buildOldestOpenBugJql('P')).toBe('project = "P" AND issuetype = Bug AND statusCategory != Done ORDER BY created ASC');
  });
  it('windows resolved durations', () => {
    expect(buildResolved90Jql('P', 90)).toBe('project = "P" AND issuetype = Bug AND statusCategory = Done AND resolutiondate >= -90d ORDER BY resolutiondate DESC');
  });
});

const JIRA = { baseUrl: 'https://x.atlassian.net', email: 'e@x', apiToken: 't', project: 'AIROBUILD', assignee: 'me', jql: null };

describe('bug fetchers', () => {
  it('reads approximate-count via POST', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body as string });
      return { ok: true, status: 200, json: async () => ({ count: 175 }) } as unknown as Response;
    }) as typeof globalThis.fetch;
    const n = await fetchApproxCount(JIRA, 'project = "AIROBUILD"');
    expect(n).toBe(175);
    expect(calls[0]!.url).toContain('/rest/api/3/search/approximate-count');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ jql: 'project = "AIROBUILD"' });
  });

  it('fetches open bugs with the bug fields', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: URL | string) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ issues: [
        { key: 'AB-1', fields: { summary: 's', priority: { name: 'P1 - High' }, duedate: '2026-09-20', resolutiondate: null, created: '2026-09-01T00:00:00Z', customfield_14808: { value: 'S2 - Medium' } } },
      ] }) } as unknown as Response;
    }) as typeof globalThis.fetch;
    const bugs = await fetchOpenBugs(JIRA, 'AIROBUILD');
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.fields.customfield_14808!.value).toBe('S2 - Medium');
    expect(seenUrl).toContain('customfield_14808');
    expect(seenUrl).toContain('duedate');
  });

  it('returns the oldest open bug or null', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ issues: [
      { key: 'AB-2992', fields: { summary: 's', priority: null, duedate: null, resolutiondate: null, created: '2026-06-25T00:00:00Z', customfield_14808: null } },
    ] }) }) as unknown as Response) as typeof globalThis.fetch;
    expect(await fetchOldestOpenBug(JIRA, 'AIROBUILD')).toEqual({ key: 'AB-2992', created: '2026-06-25T00:00:00Z' });

    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ issues: [] }) }) as unknown as Response) as typeof globalThis.fetch;
    expect(await fetchOldestOpenBug(JIRA, 'AIROBUILD')).toBeNull();
  });

  it('computes resolution durations in whole days', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ issues: [
      { key: 'AB-1', fields: { summary: 's', priority: null, duedate: null, created: '2026-09-01T00:00:00Z', resolutiondate: '2026-09-11T00:00:00Z', customfield_14808: null } },
      { key: 'AB-2', fields: { summary: 's', priority: null, duedate: null, created: '2026-09-01T00:00:00Z', resolutiondate: null, customfield_14808: null } },
    ] }) }) as unknown as Response) as typeof globalThis.fetch;
    expect(await fetchResolvedDurations(JIRA, 'AIROBUILD', 90)).toEqual([10]);
  });
});
