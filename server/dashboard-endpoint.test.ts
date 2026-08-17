import { describe, expect, it } from 'vitest';
import { buildDashboardResponse } from './dashboard-endpoint';

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
  loadMock: async () => { throw new Error('mock should not be called'); },
};

describe('buildDashboardResponse', () => {
  it('returns live data with empty degraded list when all sources succeed', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, OK_DEPS);
    expect(r.degraded).toEqual([]);
    expect(r.snapshot.queue[0].id).toBe('Q-1');
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
});
