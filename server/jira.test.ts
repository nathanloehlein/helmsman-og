import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssueSummary, fetchTriageGroups } from './jira';
import type { JiraConfig } from './config';
import type { JiraIssue } from './types';

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
