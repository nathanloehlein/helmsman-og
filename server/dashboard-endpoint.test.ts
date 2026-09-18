import { describe, expect, it, vi } from 'vitest';
import { buildDashboardResponse } from './dashboard-endpoint';
import type { JiraConfig } from './config';

const NOW = new Date('2026-08-17T12:00:00.000Z');

const FULL_ENV = {
  JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD', JIRA_ASSIGNEE: 'me',
  GITHUB_TOKEN: 'gh', GITHUB_REPO: 'o/r', GITHUB_PR_AUTHOR: 'bot',
};

const OK_DEPS = {
  fetchQueueIssues: async () => [{ key: 'Q-1', fields: { summary: 'q', status: { name: 'Backlog', statusCategory: { key: 'new' } }, priority: { name: 'P1' }, resolutiondate: null } }],
  fetchActiveIssues: async () => [],
  fetchAuthoredPrs: async () => [],
  fetchOpenAuthoredPrs: async () => [],
  loadMock: async () => { throw new Error('mock should not be called'); },
};

describe('buildDashboardResponse', () => {
  it('returns live data with empty degraded list when all sources succeed', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, OK_DEPS);
    expect(r.degraded).toEqual([]);
    expect(r.snapshot.queue[0].id).toBe('Q-1');
    expect(r.jiraBaseUrl).toBe('https://x.atlassian.net');
    expect(r.snapshot.underway).toEqual([]);
    expect(r.snapshot.underwayAvailable).toBe(false);
  });

  it('maps older assigned work using the selected repository Jira project and full configuration', async () => {
    let seenJira: JiraConfig | undefined;
    const r = await buildDashboardResponse(
      { ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA' }, NOW,
      {
        ...OK_DEPS,
        fetchMineOpenIssues: async (jira) => {
          seenJira = jira;
          return [{ key: 'PROJA-1', fields: {
            summary: 'Older assigned work', status: { name: 'To Do', statusCategory: { key: 'new' } },
            priority: { name: 'P2' }, resolutiondate: null, updated: '2025-01-01T00:00:00Z',
          } }];
        },
      }, 'o/a',
    );
    expect(seenJira).toEqual({
      baseUrl: FULL_ENV.JIRA_BASE_URL, email: FULL_ENV.JIRA_EMAIL, apiToken: FULL_ENV.JIRA_API_TOKEN,
      project: 'PROJA', assignee: 'me', jql: null,
    });
    expect(r.snapshot.underwayAvailable).toBe(true);
    expect(r.snapshot.underway).toEqual([{
      id: 'PROJA-1', title: 'Older assigned work', status: 'backlog', priority: 'P2', repo: 'o/a',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }]);
  });

  it('preserves live dashboard fields when assigned work is unavailable', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, {
      ...OK_DEPS,
      fetchMineOpenIssues: async () => { throw new Error('unavailable'); },
    });
    expect(r.degraded).toEqual(['jira-underway']);
    expect(r.snapshot.queue[0]?.id).toBe('Q-1');
    expect(r.snapshot.underway).toEqual([]);
    expect(r.snapshot.underwayAvailable).toBe(false);
  });

  it('returns a null jiraBaseUrl when Jira is not configured', async () => {
    const r = await buildDashboardResponse({}, NOW, {
      ...OK_DEPS,
      loadMock: async () => (await import('../src/data/mock')).loadDashboard(),
    });
    expect(r.jiraBaseUrl).toBeNull();
    expect(r.snapshot.underway).toEqual([]);
    expect(r.snapshot.underwayAvailable).toBe(false);
  });

  it('degrades to mock queue when Jira throws, keeps GitHub', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, {
      ...OK_DEPS,
      fetchQueueIssues: async () => { throw new Error('boom'); },
      fetchActiveIssues: async () => { throw new Error('boom'); },
      loadMock: async () => (await import('../src/data/mock')).loadDashboard(),
    });
    expect(r.degraded).toContain('jira');
    expect(r.snapshot.shipped).toEqual([]);
  });

  it('fully degrades to mock when nothing is configured', async () => {
    const r = await buildDashboardResponse({}, NOW, {
      ...OK_DEPS,
      loadMock: async () => (await import('../src/data/mock')).loadDashboard(),
    });
    expect(r.degraded).toContain('jira');
    expect(r.degraded).toContain('github');
    expect(r.snapshot.queue.length).toBeGreaterThan(0);
  });

  it('re-scopes Jira to the mapped project and filters shipped and open PRs to the selected repo', async () => {
    const prA = { number: 1, title: 'a', headRef: '', authorLogin: 'bot', state: 'open' as const, mergedAt: null, createdAt: NOW.toISOString(), reviewDecision: null, repo: 'o/a' };
    const prB = { ...prA, number: 2, repo: 'o/b' };
    let seenProject = '';
    const r = await buildDashboardResponse(
      { ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA,o/b=PROJB' },
      NOW,
      {
        ...OK_DEPS,
        fetchQueueIssues: async (jira: { project: string }) => {
          seenProject = jira.project;
          return [];
        },
        fetchActiveIssues: async () => [],
        fetchAuthoredPrs: async () => [prA, prB],
        fetchOpenAuthoredPrs: async () => [
          { number: 1, title: 'a', repo: 'o/a', reviewDecision: 'REVIEW_REQUIRED', draft: false, createdAt: NOW.toISOString() },
          { number: 2, title: 'b', repo: 'o/b', reviewDecision: 'APPROVED', draft: false, createdAt: NOW.toISOString() },
        ],
      },
      'o/a',
    );
    expect(seenProject).toBe('PROJA');
    expect(r.snapshot.shipped.map((p) => p.number)).toEqual([1]);
    expect(r.snapshot.myOpenPrs.map((p) => p.number)).toEqual([1]);
    expect(r.repos).toEqual(['o/a', 'o/b']);
    expect(r.selectedRepo).toBe('o/a');
  });

  it.each([
    { selectedRepo: null, expected: [1, 2] },
    { selectedRepo: 'O/A', expected: [1] },
  ])('filters open PRs case-insensitively and preserves all-galleon scope: $selectedRepo', async ({ selectedRepo, expected }) => {
    const result = await buildDashboardResponse(FULL_ENV, NOW, {
      ...OK_DEPS,
      fetchOpenAuthoredPrs: async () => [
        { number: 1, title: 'a', repo: 'o/a', reviewDecision: null, draft: false, createdAt: NOW.toISOString() },
        { number: 2, title: 'b', repo: 'o/b', reviewDecision: null, draft: false, createdAt: NOW.toISOString() },
      ],
    }, selectedRepo);
    expect(result.snapshot.myOpenPrs.map(pr => pr.number).sort()).toEqual(expected);
  });

  it('uses the default Jira project and all repos when no repo is selected', async () => {
    let seenProject = '';
    const r = await buildDashboardResponse(
      { ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA' },
      NOW,
      {
        ...OK_DEPS,
        fetchQueueIssues: async (jira: { project: string }) => {
          seenProject = jira.project;
          return [];
        },
      },
    );
    expect(seenProject).toBe('AIROBUILD');
    expect(r.selectedRepo).toBeNull();
    expect(r.repos).toEqual(['o/a']);
  });

  it('never substitutes the default Jira project for an unmapped repository', async () => {
    const fetchQueueIssues = vi.fn(OK_DEPS.fetchQueueIssues);
    const fetchActiveIssues = vi.fn(OK_DEPS.fetchActiveIssues);
    const fetchMineOpenIssues = vi.fn(OK_DEPS.fetchQueueIssues);
    const result = await buildDashboardResponse({ ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA' }, NOW,
      { ...OK_DEPS, fetchQueueIssues, fetchActiveIssues, fetchMineOpenIssues }, 'o/unmapped');
    expect(fetchQueueIssues).not.toHaveBeenCalled();
    expect(fetchActiveIssues).not.toHaveBeenCalled();
    expect(fetchMineOpenIssues).not.toHaveBeenCalled();
    expect(result.snapshot.queue).toEqual([]);
    expect(result.snapshot.underway).toEqual([]);
    expect(result.snapshot.activity).toEqual([]);
    expect(result.snapshot.stats.awaitingReview).toBe(0);
  });

  it('filters cross-project query results before deriving every Jira panel and keeps full repository identity', async () => {
    const issue = (key: string) => ({ key, fields: {
      summary: key, status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, priority: null, resolutiondate: null,
    }, changelog: { histories: [{ created: NOW.toISOString(), items: [{ field: 'status', fromString: 'In Progress', toString: 'In Review' }] }] } });
    const rows = [issue('PROJA-1'), issue('PROJB-2')];
    const result = await buildDashboardResponse({ ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA,o/b=PROJB', JIRA_JQL: 'assignee = currentUser()' }, NOW, {
      ...OK_DEPS, fetchQueueIssues: async () => rows, fetchActiveIssues: async () => rows, fetchMineOpenIssues: async () => rows,
    }, 'o/a');
    expect(result.snapshot.queue.map(ticket => [ticket.id, ticket.repo])).toEqual([['PROJA-1', 'o/a']]);
    expect(result.snapshot.underway?.map(ticket => ticket.id)).toEqual(['PROJA-1']);
    expect(result.snapshot.stats.awaitingReview).toBe(1);
    expect(result.snapshot.activity.map(event => event.text).join(' ')).not.toContain('PROJB');
  });

  it('does not fill a selected repository with unrelated sample data when integrations fail', async () => {
    const loadMock = vi.fn(OK_DEPS.loadMock);
    const result = await buildDashboardResponse({ ...FULL_ENV, REPO_PROJECT_MAP: 'o/a=PROJA' }, NOW, {
      ...OK_DEPS, loadMock,
      fetchQueueIssues: async () => { throw new Error('unavailable'); },
      fetchAuthoredPrs: async () => { throw new Error('unavailable'); },
    }, 'o/a');
    expect(loadMock).not.toHaveBeenCalled();
    expect(result.degraded).toEqual(expect.arrayContaining(['jira', 'github']));
    expect(result.snapshot.queue).toEqual([]);
    expect(result.snapshot.shipped).toEqual([]);
    expect(result.snapshot.activity).toEqual([]);
  });
});

describe('local todo dashboard', () => {
  it('uses local queue and states without any Jira requests or mock fallback', async () => {
    const forbidden = async (): Promise<never> => { throw new Error('Must not fetch Jira or mock data'); };
    const base = { title: 'Local work', repo: 'o/local', description: 'Detailed requirements', acceptanceCriteria: '', priority: 'P0' as const, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), completedAt: NOW.toISOString(), runId: null };
    const todos = [
      { ...base, id: 'TODO-1', state: 'todo' as const },
      { ...base, id: 'TODO-2', state: 'in_review' as const },
      { ...base, id: 'TODO-3', state: 'done' as const },
      { ...base, id: 'TODO-4', state: 'blocked' as const },
      { ...base, id: 'TODO-5', state: 'todo' as const, repo: 'o/other' },
    ];
    const result = await buildDashboardResponse({ ...FULL_ENV, JIRA_ENABLED: 'false', GITHUB_TOKEN: '' }, NOW, {
      ...OK_DEPS, fetchQueueIssues: forbidden, fetchActiveIssues: forbidden, fetchMineOpenIssues: forbidden, loadMock: forbidden,
    }, 'o/local', todos);
    expect(result.jiraEnabled).toBe(false);
    expect(result.jiraBaseUrl).toBeNull();
    expect(result.degraded).toEqual(['github']);
    expect(result.snapshot.queue.map(todo => todo.id)).toEqual(['TODO-1']);
    expect(result.snapshot.underway?.map(todo => todo.id)).toEqual(['TODO-2']);
    expect(result.snapshot.stats).toEqual({ completedToday: 1, awaitingReview: 1, avgCycleMinutes: 0 });
    expect(result.snapshot.throughput7d).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(result.repos).toContain('o/local');
    expect(result.snapshot.steps).toEqual([]);
    expect(result.snapshot.myOpenPrs).toEqual([]);
  });
});


it('includes todo-only repositories in GitHub queries and excludes drafts from the launch queue', async () => {
  const fetchAuthoredPrs = vi.fn(async (_github: unknown, _repos: string[]) => []);
  const fetchOpenAuthoredPrs = vi.fn(async (_github: unknown, _repos: string[]) => []);
  const result = await buildDashboardResponse({ ...FULL_ENV, JIRA_ENABLED: 'false' }, NOW, {
    ...OK_DEPS, fetchAuthoredPrs, fetchOpenAuthoredPrs,
  }, null, [{ id: 'TODO-1', title: 'Draft', repo: 'owner/new-repo', description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), completedAt: null, runId: null }]);
  expect(fetchAuthoredPrs.mock.calls[0]?.[1]).toContain('owner/new-repo');
  expect(fetchOpenAuthoredPrs.mock.calls[0]?.[1]).toContain('owner/new-repo');
  expect(result.snapshot.queue).toEqual([]);
});
