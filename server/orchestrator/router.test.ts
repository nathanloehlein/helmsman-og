import { describe, expect, it, vi } from 'vitest';
import { handleApi, type RouterDeps } from './router';
import type { PrStatus } from '../github';

const samplePrStatus: PrStatus = {
  number: 5,
  repo: 'o/r',
  state: 'open',
  draft: false,
  merged: false,
  headRefName: 'feat/x',
  headSha: 'abc123',
  reviewDecision: 'REVIEW_REQUIRED',
  comments: 0,
  checks: { passed: 1, failed: 0, pending: 0 },
  reviews: { requested: 0, approved: 0, changesRequested: 0, commented: 0 },
  url: 'https://github.com/o/r/pull/5',
};

const deps: RouterDeps = {
  dashboard: async (repo) => ({ snapshot: { repo: repo ?? 'all' }, degraded: [], repos: ['o/r'], selectedRepo: repo }),
  triage: async (repo) => ({
    groups: { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] },
    degraded: false,
    selectedRepo: repo,
    jiraBaseUrl: 'https://x.atlassian.net',
  }),
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
  } as unknown as RouterDeps['db'],
  canStart: (_repo: string) => ({ ok: true }),
  launch: (_body: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-0',
  stop: (_id: string) => false,
  setAutoClaim: (_repo: string, _enabled: boolean) => {},
  autoClaimRepos: () => ['o/r'],
  caps: () => ({ maxAttempts: 3, maxCostUsd: 5 }),
  getConfig: () => ({ config: { agentAdapter: 'claude-code', maxAttempts: 1 }, overridden: ['AGENT_MAX_ATTEMPTS'] }),
  setConfig: (_key: string, _value: string) => ({ ok: true }),
  prStatus: async (_repo: string, _prNumber: number) => samplePrStatus,
  submitReview: async (_repo: string, _prNumber: number, _event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', _body: string) => ({ ok: true as const }),
  cmuxListTabs: async () => ({ connected: true, tabs: [] }),
  cmuxReadScreen: async (_surface: string, _lines: number) => ({ ok: true as const, text: '' }),
  cmuxSend: async (_surface: string, _text: string, _enter: boolean) => ({ ok: true as const }),
  cmuxPasteImage: async (_surface: string, _dataBase64: string, _ext: string) => ({ ok: true as const, path: '/tmp/x.png' }),
  cmuxAction: async (_surface: string, _provider: string | null, _action: string) => ({ ok: true as const, keys: [] }),
  cmuxKey: async (_surface: string, _key: string) => ({ ok: true as const }),
};

describe('handleApi', () => {
  it('serves the dashboard with the repo query', async () => {
    const r = await handleApi('GET', '/api/dashboard', new URLSearchParams('repo=o/r'), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { selectedRepo: string }).selectedRepo).toBe('o/r');
  });

  it('serves triage groups with the repo query', async () => {
    const r = await handleApi('GET', '/api/triage', new URLSearchParams('repo=o/r'), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { selectedRepo: string }).selectedRepo).toBe('o/r');
    expect((r?.json as { groups: unknown }).groups).toBeDefined();
  });

  it('lists runs', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('projects runs to a client-safe shape without leaking internal fields', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    const run = (r?.json as { runs: Record<string, unknown>[] }).runs[0];
    expect(run).toEqual({
      id: 'r1',
      ticketId: 'T-1',
      repo: 'o/r',
      status: 'running',
      attempt: 1,
      prNumber: null,
      startedAt: 'x',
      costUsd: null,
    });
    expect(run).not.toHaveProperty('worktreePath');
    expect(run).not.toHaveProperty('adapter');
    expect(run).not.toHaveProperty('endedAt');
  });

  it('includes autoClaim repos from autoClaimRepos()', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { autoClaim: string[] }).autoClaim).toEqual(['o/r']);
  });

  it('includes caps from caps()', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { caps: { maxAttempts: number; maxCostUsd: number | null } }).caps).toEqual({
      maxAttempts: 3,
      maxCostUsd: 5,
    });
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

  it('launches a free-form task and calls launch with only repo and task', async () => {
    const launch = vi.fn((_b: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-9');
    const freeformDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'freeform', task: 'x', repo: 'o/r' }, freeformDeps);
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', task: 'x' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects a free-form launch missing task', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'freeform', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'task required' });
  });

  it('still launches a ticket run when mode is omitted, passing ticketId, title, and repo through', async () => {
    const launch = vi.fn((_b: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-9');
    const ticketDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', repo: 'o/r' }, ticketDeps);
    expect(launch).toHaveBeenCalledWith({ ticketId: 'T-1', title: undefined, repo: 'o/r' });
    expect(r?.status).toBe(200);
  });

  it('forwards model and effort to launch (ticket + review)', async () => {
    const launch = vi.fn(() => 'run-9');
    const d = { ...launchDeps, launch } as unknown as RouterDeps;
    await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', repo: 'o/r', model: 'opus', effort: 'high' }, d);
    expect(launch).toHaveBeenCalledWith({ ticketId: 'T-1', title: undefined, repo: 'o/r', model: 'opus', effort: 'high' });
    await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'review', repo: 'o/r', prNumber: 5, model: 'sonnet', effort: 'low' }, d);
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 5, mode: 'review', model: 'sonnet', effort: 'low' });
  });

  it('rejects a launch missing repo', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1' }, launchDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'repo required' });
  });

  it('launches a rerun and calls launch with repo, prNumber, mode, and feedback', async () => {
    const launch = vi.fn((_b: { repo: string; prNumber?: number; mode?: string; feedback?: string }) => 'run-9');
    const rerunDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi(
      'POST',
      '/api/agents/launch',
      new URLSearchParams(),
      { mode: 'rerun', repo: 'o/r', prNumber: 12, feedback: 'fix' },
      rerunDeps,
    );
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 12, mode: 'rerun', feedback: 'fix' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects a rerun launch missing prNumber', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'rerun', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
  });

  it('launches a review and calls launch with repo, prNumber, and mode', async () => {
    const launch = vi.fn((_b: { repo: string; prNumber?: number; mode?: string }) => 'run-11');
    const reviewDeps = { ...launchDeps, launch } as unknown as RouterDeps;
    const r = await handleApi(
      'POST',
      '/api/agents/launch',
      new URLSearchParams(),
      { mode: 'review', repo: 'o/r', prNumber: 12 },
      reviewDeps,
    );
    expect(launch).toHaveBeenCalledWith({ repo: 'o/r', prNumber: 12, mode: 'review' });
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-11');
  });

  it('rejects a review launch missing prNumber', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { mode: 'review', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(400);
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

describe('config routes', () => {
  it('returns config and overridden keys without leaking secret env keys', async () => {
    const r = await handleApi('GET', '/api/config', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({
      config: { agentAdapter: 'claude-code', maxAttempts: 1 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
    });
    const serialized = JSON.stringify(r?.json);
    expect(serialized).not.toContain('JIRA_API_TOKEN');
    expect(serialized).not.toContain('GITHUB_TOKEN');
    expect(serialized).not.toContain('JIRA_EMAIL');
  });

  it('updates a config value', async () => {
    const setConfig = vi.fn(() => ({ ok: true as const }));
    const configDeps = { ...deps, setConfig } as unknown as RouterDeps;
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { key: 'AGENT_MAX_ATTEMPTS', value: '3' }, configDeps);
    expect(setConfig).toHaveBeenCalledWith('AGENT_MAX_ATTEMPTS', '3');
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ key: 'AGENT_MAX_ATTEMPTS', value: '3' });
  });

  it('rejects updates to a non-editable config key', async () => {
    const setConfig = vi.fn(() => ({ ok: false as const, error: 'not an editable config key: JIRA_API_TOKEN' }));
    const configDeps = { ...deps, setConfig } as unknown as RouterDeps;
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { key: 'JIRA_API_TOKEN', value: 'x' }, configDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'not an editable config key: JIRA_API_TOKEN' });
  });

  it('rejects an update missing key', async () => {
    const r = await handleApi('PUT', '/api/config', new URLSearchParams(), { value: '3' }, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'key and value required' });
  });
});

describe('GET /api/pr', () => {
  it('returns the PR status for a repo and number', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=5'), null, deps);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual(samplePrStatus);
  });

  it('rejects a request missing number', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r'), null, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'repo and number required' });
  });

  it('rejects a request with a non-numeric number', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=x'), null, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'repo and number required' });
  });

  it('rejects a request missing repo', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('number=5'), null, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'repo and number required' });
  });

  it('returns 404 when the PR is not found or GitHub is not configured', async () => {
    const notFoundDeps = { ...deps, prStatus: async (_repo: string, _n: number) => null } as unknown as RouterDeps;
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=5'), null, notFoundDeps);
    expect(r?.status).toBe(404);
    expect(r?.json).toEqual({ error: 'PR not found or GitHub not configured' });
  });

  it('never leaks the GitHub token in the response', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=5'), null, deps);
    expect(JSON.stringify(r?.json)).not.toContain('GITHUB_TOKEN');
  });
});

describe('POST /api/pr/review', () => {
  it('submits an approve review and returns ok', async () => {
    const submitReview = vi.fn(async (_repo: string, _n: number, _event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', _body: string) => ({ ok: true as const }));
    const reviewDeps = { ...deps, submitReview } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', number: 5, event: 'APPROVE', body: '' }, reviewDeps);
    expect(submitReview).toHaveBeenCalledWith('o/r', 5, 'APPROVE', '');
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ ok: true });
  });

  it('rejects a COMMENT review with an empty body', async () => {
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', number: 5, event: 'COMMENT', body: '' }, deps);
    expect(r?.status).toBe(400);
  });

  it('rejects a REQUEST_CHANGES review with an empty body', async () => {
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', number: 5, event: 'REQUEST_CHANGES', body: '' }, deps);
    expect(r?.status).toBe(400);
  });

  it('rejects an invalid event', async () => {
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', number: 5, event: 'BOGUS', body: '' }, deps);
    expect(r?.status).toBe(400);
  });

  it('rejects a request missing number', async () => {
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', event: 'APPROVE', body: '' }, deps);
    expect(r?.status).toBe(400);
  });

  it('propagates a submitReview failure as a 400 with the error', async () => {
    const submitReview = async (_repo: string, _n: number, _event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', _body: string) => ({ ok: false as const, error: 'nope' });
    const reviewDeps = { ...deps, submitReview } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/pr/review', new URLSearchParams(), { repo: 'o/r', number: 5, event: 'APPROVE', body: '' }, reviewDeps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'nope' });
  });
});

function baseCmuxDeps(over: Partial<RouterDeps>): RouterDeps {
  return {
    cmuxListTabs: () => Promise.resolve({ connected: true, tabs: [] }),
    cmuxReadScreen: () => Promise.resolve({ ok: true, text: 'screen' }),
    cmuxSend: () => Promise.resolve({ ok: true }),
    cmuxAction: () => Promise.resolve({ ok: true, keys: ['Enter'] }),
    cmuxKey: () => Promise.resolve({ ok: true }),
    ...over,
  } as unknown as RouterDeps;
}

describe('cmux endpoints', () => {
  it('GET /api/cmux/tabs returns the bridge result', async () => {
    const res = await handleApi('GET', '/api/cmux/tabs', new URLSearchParams(), null, baseCmuxDeps({}));
    expect(res).toEqual({ status: 200, json: { connected: true, tabs: [] } });
  });

  it('GET /api/cmux/screen requires a surface', async () => {
    const res = await handleApi('GET', '/api/cmux/screen', new URLSearchParams(), null, baseCmuxDeps({}));
    expect(res?.status).toBe(400);
  });

  it('POST /api/cmux/send forwards text + enter, requires surface and text', async () => {
    const calls: unknown[] = [];
    const cmuxDeps = baseCmuxDeps({
      cmuxSend: (s, t, e) => {
        calls.push([s, t, e]);
        return Promise.resolve({ ok: true });
      },
    });
    const bad = await handleApi('POST', '/api/cmux/send', new URLSearchParams(), { surface: 'surface:1' }, cmuxDeps);
    expect(bad?.status).toBe(400);
    const ok = await handleApi('POST', '/api/cmux/send', new URLSearchParams(), { surface: 'surface:1', text: 'ls', enter: true }, cmuxDeps);
    expect(ok?.status).toBe(200);
    expect(calls).toEqual([['surface:1', 'ls', true]]);
  });

  it('POST /api/cmux/paste-image writes the image and returns its path, requires surface and data', async () => {
    const calls: unknown[] = [];
    const cmuxDeps = baseCmuxDeps({
      cmuxPasteImage: (s, d, e) => {
        calls.push([s, d, e]);
        return Promise.resolve({ ok: true, path: '/tmp/gomaestro-clip-x.png' });
      },
    });
    const bad = await handleApi('POST', '/api/cmux/paste-image', new URLSearchParams(), { surface: 'surface:1' }, cmuxDeps);
    expect(bad?.status).toBe(400);
    const ok = await handleApi('POST', '/api/cmux/paste-image', new URLSearchParams(), { surface: 'surface:1', dataBase64: 'aGk=', ext: 'png' }, cmuxDeps);
    expect(ok?.status).toBe(200);
    expect((ok?.json as { path?: string }).path).toBe('/tmp/gomaestro-clip-x.png');
    expect(calls).toEqual([['surface:1', 'aGk=', 'png']]);
  });

  it('POST /api/cmux/action rejects an unknown action', async () => {
    const cmuxDeps = baseCmuxDeps({ cmuxAction: () => Promise.resolve({ ok: false, error: 'unknown action' }) });
    const res = await handleApi('POST', '/api/cmux/action', new URLSearchParams(), { surface: 'surface:1', action: 'nope' }, cmuxDeps);
    expect(res?.status).toBe(400);
  });

  it('POST /api/cmux/key requires surface and key', async () => {
    const noSurface = await handleApi('POST', '/api/cmux/key', new URLSearchParams(), { key: 'up' }, baseCmuxDeps({}));
    expect(noSurface?.status).toBe(400);
    const noKey = await handleApi('POST', '/api/cmux/key', new URLSearchParams(), { surface: 'surface:1' }, baseCmuxDeps({}));
    expect(noKey?.status).toBe(400);
  });

  it('POST /api/cmux/key rejects a disallowed key without calling cmuxKey', async () => {
    const calls: unknown[] = [];
    const cmuxDeps = baseCmuxDeps({
      cmuxKey: (s, k) => {
        calls.push([s, k]);
        return Promise.resolve({ ok: true });
      },
    });
    const res = await handleApi('POST', '/api/cmux/key', new URLSearchParams(), { surface: 'surface:1', key: 'f1' }, cmuxDeps);
    expect(res?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('POST /api/cmux/key forwards an allowed key to cmuxKey', async () => {
    const calls: unknown[] = [];
    const cmuxDeps = baseCmuxDeps({
      cmuxKey: (s, k) => {
        calls.push([s, k]);
        return Promise.resolve({ ok: true });
      },
    });
    const res = await handleApi('POST', '/api/cmux/key', new URLSearchParams(), { surface: 'surface:1', key: 'up' }, cmuxDeps);
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(calls).toEqual([['surface:1', 'up']]);
  });
});
