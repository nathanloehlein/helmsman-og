import { describe, expect, it } from 'vitest';
import { handleApi, type RouterDeps } from './router';

const deps: RouterDeps = {
  dashboard: async (repo) => ({ snapshot: { repo: repo ?? 'all' }, degraded: [], repos: ['o/r'], selectedRepo: repo }),
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
  } as unknown as RouterDeps['db'],
};

describe('handleApi', () => {
  it('serves the dashboard with the repo query', async () => {
    const r = await handleApi('GET', '/api/dashboard', new URLSearchParams('repo=o/r'), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { selectedRepo: string }).selectedRepo).toBe('o/r');
  });

  it('lists runs', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('returns null for non-API paths', async () => {
    expect(await handleApi('GET', '/index.html', new URLSearchParams(), null, deps)).toBeNull();
  });
});
