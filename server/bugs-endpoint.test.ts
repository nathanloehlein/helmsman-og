import { describe, expect, it } from 'vitest';
import { buildBugsResponse, type BugsDeps } from './bugs-endpoint';
import type { BugIssue } from './jira';

const NOW = new Date('2026-09-15T16:00:00Z');

const ENV: Record<string, string | undefined> = {
  JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'e@x', JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD', JIRA_ASSIGNEE: 'me',
  REPO_PROJECT_MAP: 'o/a=AIROBUILD,o/b=OTHER',
};

function bug(over: Partial<BugIssue['fields']> = {}, key = 'AB-1'): BugIssue {
  return { key, fields: { summary: 't', priority: { name: 'P1 - High' }, duedate: '2026-09-08', resolutiondate: null, created: '2026-09-01T00:00:00Z', customfield_14808: { value: 'S2 - Medium' }, ...over } };
}

function okDeps(over: Partial<BugsDeps> = {}): BugsDeps {
  return {
    verifyAuth: async () => {},
    fetchApproxCount: async () => 5,
    fetchOpenBugs: async () => [bug()],
    fetchOldestOpenBug: async () => ({ key: 'AB-1', created: '2026-06-25T00:00:00Z' }),
    fetchResolvedDurations: async () => [1, 2, 3, 4, 5],
    ...over,
  };
}

describe('buildBugsResponse', () => {
  it('degrades when Jira is not configured', async () => {
    const res = await buildBugsResponse({}, NOW, okDeps());
    expect(res.degraded).toBe(true);
    expect(res.cards).toEqual([]);
  });

  it('builds one card per mapped project', async () => {
    const res = await buildBugsResponse(ENV, NOW, okDeps());
    expect(res.degraded).toBe(false);
    expect(res.cards.map((c) => c.project).sort()).toEqual(['AIROBUILD', 'OTHER']);
    const card = res.cards.find((c) => c.project === 'AIROBUILD')!;
    expect(card.rows[0]!.severity).toBe('S2 - Medium');
    expect(card.rows[0]!.sla.overdue).toBe(true);
    expect(card.oldest).toEqual({ key: 'AB-1', ageDays: 82 });
  });

  it('scopes to a single project when repo is given', async () => {
    const res = await buildBugsResponse(ENV, NOW, okDeps(), 'o/a');
    expect(res.cards.map((c) => c.project)).toEqual(['AIROBUILD']);
  });

  it('degrades globally (no fake zeros) when auth fails', async () => {
    let counted = false;
    const deps = okDeps({
      verifyAuth: async () => { throw new Error('Jira 401'); },
      fetchApproxCount: async () => { counted = true; return 0; },
    });
    const res = await buildBugsResponse(ENV, NOW, deps);
    expect(res.degraded).toBe(true);
    expect(res.cards).toEqual([]);
    expect(counted).toBe(false);
  });

  it('degrades only the failing project card', async () => {
    let n = 0;
    const deps = okDeps({
      fetchOpenBugs: async (_j, project: string) => {
        if (project === 'OTHER') throw new Error('boom');
        n += 1;
        return [bug()];
      },
    });
    const res = await buildBugsResponse(ENV, NOW, deps);
    expect(res.degraded).toBe(false);
    expect(res.cards.find((c) => c.project === 'OTHER')!.degraded).toBe(true);
    expect(res.cards.find((c) => c.project === 'AIROBUILD')!.degraded).toBe(false);
    expect(n).toBe(1);
  });
});
