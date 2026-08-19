import { describe, expect, it, vi } from 'vitest';
import { handleApi, type RouterDeps } from './router';

const deps: RouterDeps = {
  dashboard: async (repo) => ({ snapshot: { repo: repo ?? 'all' }, degraded: [], repos: ['o/r'], selectedRepo: repo }),
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
  } as unknown as RouterDeps['db'],
  canStart: (_repo: string) => ({ ok: true }),
  launch: (_body: { ticketId: string; title: string; repo: string }) => 'run-0',
  stop: (_id: string) => false,
  setAutoClaim: (_repo: string, _enabled: boolean) => {},
  autoClaimRepos: () => ['o/r'],
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

  it('includes autoClaim repos from autoClaimRepos()', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { autoClaim: string[] }).autoClaim).toEqual(['o/r']);
  });

  it('returns null for non-API paths', async () => {
    expect(await handleApi('GET', '/index.html', new URLSearchParams(), null, deps)).toBeNull();
  });
});

const launchDeps = {
  ...deps,
  canStart: (_repo: string) => ({ ok: true }),
  launch: vi.fn((_b: { ticketId: string; title: string; repo: string }) => 'run-9'),
  stop: (id: string) => id === 'run-9',
} as unknown as RouterDeps;

describe('agent control routes', () => {
  it('launches a run and returns the id', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects launch when single-flight blocks it', async () => {
    const blocked = { ...launchDeps, canStart: () => ({ ok: false, reason: 'busy' }) } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, blocked);
    expect(r?.status).toBe(409);
  });

  it('stops a run', async () => {
    const r = await handleApi('POST', '/api/agents/run-9/stop', new URLSearchParams(), null, launchDeps);
    expect(r?.status).toBe(200);
  });
});

describe('auto-claim toggle route', () => {
  it('toggles auto-claim for a repo and echoes the result', async () => {
    const setAutoClaim = vi.fn();
    const toggleDeps = { ...launchDeps, setAutoClaim } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/repos/o%2Fr/auto-claim', new URLSearchParams(), { enabled: true }, toggleDeps);
    expect(setAutoClaim).toHaveBeenCalledWith('o/r', true);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ repo: 'o/r', enabled: true });
  });

  it('URL-decodes the repo segment', async () => {
    const setAutoClaim = vi.fn();
    const toggleDeps = { ...launchDeps, setAutoClaim } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/repos/owner%2Fname/auto-claim', new URLSearchParams(), { enabled: false }, toggleDeps);
    expect(setAutoClaim).toHaveBeenCalledWith('owner/name', false);
    expect(r?.json).toEqual({ repo: 'owner/name', enabled: false });
  });
});
