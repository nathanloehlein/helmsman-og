import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunConflictError } from './process-manager';
import { handleApi, type RouterDeps } from './router';
import { openTodoStore, type TodoStore } from './todos';
import { SlackReviewError } from './slack/review-request';
import { ResumeError } from './resume';
import type { PrStatus } from '../github';
import type { BugsResponse } from '../../src/types';
import { openDb, type RunRow } from './db';

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
  bugs: async (): Promise<BugsResponse> => ({ cards: [], degraded: false, generatedAt: '', latestWindow: '', previousWindow: '' }),
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
    latestReviewVerdict: () => null,
  } as unknown as RouterDeps['db'],
  canStart: (_repo: string) => ({ ok: true }),
  launch: (_body: { ticketId?: string; title?: string; repo: string; task?: string }) => 'run-0',
  stop: (_id: string) => false,
  setAutoClaim: (_repo: string, _enabled: boolean) => {},
  autoClaimRepos: () => ['o/r'],
  caps: () => ({ maxAttempts: 3, maxCostUsd: 5 }),
  getConfig: () => ({ config: { agentAdapter: 'claude-code', maxAttempts: 1 }, overridden: ['AGENT_MAX_ATTEMPTS'], jiraTokenSet: true }),
  setConfig: (_key: string, _value: string) => ({ ok: true }),
  prStatus: async (_repo: string, _prNumber: number) => samplePrStatus,
  reviewRequestedPrs: async () => ({ prs: [], degraded: false, truncated: false }),
  repoOpenPrs: async () => ({ prs: [], degraded: false, truncated: false }),
  localGit: async () => ({ status: 200, json: { repo: 'o/r', path: '/agents/r', branches: [], worktrees: [], error: null } }),
  prDiff: async (_repo: string, _prNumber: number) => [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ x @@' }],
  submitReview: async (_repo: string, _prNumber: number, _event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', _body: string) => ({ ok: true as const }),
  cmuxListTabs: async () => ({ connected: true, tabs: [] }),
  cmuxReadScreen: async (_surface: string, _lines: number) => ({ ok: true as const, text: '' }),
  cmuxSend: async (_surface: string, _text: string, _enter: boolean) => ({ ok: true as const }),
  cmuxPasteImage: async (_surface: string, _dataBase64: string, _ext: string) => ({ ok: true as const, path: '/tmp/x.png' }),
  cmuxAction: async (_surface: string, _provider: string | null, _action: string) => ({ ok: true as const, keys: [] }),
  cmuxKey: async (_surface: string, _key: string) => ({ ok: true as const }),
};

describe('handleApi', () => {
  it('reads Slack request history with explicit galleon scope without sending', async () => {
    const slackReviewRequests = vi.fn(() => []);
    const slackReviewRequest = vi.fn();
    const local = { ...deps, slackReviewRequests, slackReviewRequest };
    expect(await handleApi('GET', '/api/slack/review-requests', new URLSearchParams('repo=o/r'), null, local))
      .toEqual({ status: 200, json: { requests: [] } });
    expect(slackReviewRequests).toHaveBeenLastCalledWith('o/r');
    await handleApi('GET', '/api/slack/review-requests', new URLSearchParams(), null, local);
    expect(slackReviewRequests).toHaveBeenLastCalledWith(null);
    expect((await handleApi('GET', '/api/slack/review-requests', new URLSearchParams('repo=bad'), null, local))?.status).toBe(400);
    expect(slackReviewRequests).toHaveBeenCalledTimes(2);
    expect(slackReviewRequest).not.toHaveBeenCalled();
    expect((await handleApi('GET', '/api/slack/review-requests', new URLSearchParams(), null, deps))?.status).toBe(503);
  });
  it('continues an existing voyage without creating a replacement run', async () => {
    const resumeRun = vi.fn(async () => {});
    const launch = vi.fn(deps.launch);
    const local = { ...deps, launch, resumeRun, db: { ...deps.db, getRun: () => ({ id: 'original' }) as RunRow } };
    expect(await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), { task: 'ignored' }, local))
      .toEqual({ status: 200, json: { runId: 'original' } });
    expect(resumeRun).toHaveBeenCalledExactlyOnceWith('original');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns continuation validation failures without starting a new run', async () => {
    const resumeRun = vi.fn(async () => { throw new ResumeError('Retained worktree has changed.'); });
    const local = { ...deps, resumeRun, db: { ...deps.db, getRun: () => ({ id: 'original' }) as RunRow } };
    expect(await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), null, local))
      .toEqual({ status: 409, json: { error: 'Retained worktree has changed.' } });
    expect((await handleApi('POST', '/api/agents/bad%20id/resume', new URLSearchParams(), null, local))?.status).toBe(400);
    expect((await handleApi('POST', '/api/agents/original/resume', new URLSearchParams(), null, { ...local, db: { ...local.db, getRun: () => null } }))?.status).toBe(404);
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });
  it('serves only public GitHub profile fields without using the selected galleon', async () => {
    const githubProfile = vi.fn(async () => ({ displayName: 'Captain Example', login: 'captain', token: 'private' }));
    expect(await handleApi('GET', '/api/github/profile', new URLSearchParams('repo=o/r'), null, { ...deps, githubProfile }))
      .toEqual({ status: 200, json: { displayName: 'Captain Example', login: 'captain' } });
    expect(githubProfile).toHaveBeenCalledExactlyOnceWith();
  });

  it('returns empty profile fields when the GitHub profile source is unavailable', async () => {
    expect(await handleApi('GET', '/api/github/profile', new URLSearchParams(), null, deps))
      .toEqual({ status: 200, json: { displayName: null, login: null } });
  });

  describe('retry failed voyages', () => {
    const failed = (extra: Partial<RunRow> = {}): RunRow => ({
      id: 'failed-run', ticketId: 'PROJ-1', repo: 'o/r', adapter: 'pre-pr:codex', status: 'failed', attempt: 1,
      prNumber: null, startedAt: '2026-09-18', endedAt: '2026-09-18', costUsd: null, worktreePath: '/old/worktree', ...extra,
    });
    const retry = (local: RouterDeps, id = 'failed-run') => handleApi('POST', `/api/agents/${id}/retry`, new URLSearchParams(), null, local);

    it('starts a fresh Jira voyage without changing failed history or reusing its process/worktree', async () => {
      const db = openDb(':memory:');
      try {
        const original = failed({ taskJson: JSON.stringify({ ticketId: 'AIROBUILD-5319', title: 'old', repo: 'o/r', model: 'gpt-5.5', effort: 'high' }) });
        db.insertRun(original);
        const before = db.getRun(original.id);
        const launch = vi.fn(() => 'fresh-run');
        const local = { ...deps, db, launch, context: () => ({ repos: ['o/r'], jiraBaseUrl: 'https://jira' }) };
        expect(await retry(local)).toEqual({ status: 200, json: { runId: 'fresh-run' } });
        expect(launch).toHaveBeenCalledExactlyOnceWith({ repo: 'o/r', adapter: 'codex', mode: 'ticket', ticketId: 'AIROBUILD-5319', model: 'gpt-5.5', effort: 'high', retryOf: original.id });
        expect(db.getRun(original.id)).toEqual(before);
      } finally { db.close(); }
    });

    it.each(['running', 'succeeded', 'stopped'] as const)('rejects %s voyages before launch', async status => {
      const launch = vi.fn();
      const local = { ...deps, launch, db: { ...deps.db, getRun: () => failed({ status }) } };
      expect(await retry(local)).toMatchObject({ status: 409, json: { error: 'Only failed voyages can be retried.' } });
      expect(launch).not.toHaveBeenCalled();
    });

    it('rejects missing IDs, removed repositories, disabled Jira, caps, and missing requirements', async () => {
      const launch = vi.fn();
      const local = { ...deps, launch, db: { ...deps.db, getRun: () => failed() } };
      expect((await retry({ ...local, db: { ...deps.db, getRun: () => null } }))?.status).toBe(404);
      expect((await retry(local, 'bad%20id'))?.status).toBe(400);
      expect((await retry({ ...local, context: () => ({ repos: [], jiraBaseUrl: null }) }))?.status).toBe(409);
      expect((await retry({ ...local, jiraEnabled: () => false }))?.status).toBe(409);
      expect(await retry({ ...local, canStart: () => ({ ok: false, reason: 'max concurrency reached' }) }))
        .toEqual({ status: 409, json: { error: 'max concurrency reached' } });
      expect((await retry({ ...local, db: { ...deps.db, getRun: () => failed({ ticketId: 'freeform' }) } }))?.status).toBe(409);
      expect(launch).not.toHaveBeenCalled();
    });

    it('retries reviews and PR updates while Jira is disabled, preserving their original semantics', async () => {
      const launch = vi.fn(() => 'fresh-run');
      for (const [mode, task] of [
        ['review', { review: true, prNumber: 3, prHeadSha: 'old-head' }],
        ['rerun', { prBranch: 'old-branch', prNumber: 3, task: 'Fix feedback' }],
      ] as const) {
        const local = { ...deps, launch, jiraEnabled: () => false, db: { ...deps.db, getRun: () => failed({ taskJson: JSON.stringify(task) }) } };
        expect((await retry(local))?.status).toBe(200);
        expect(launch).toHaveBeenLastCalledWith({ repo: 'o/r', adapter: 'codex', mode, prNumber: 3, retryOf: 'failed-run', ...(mode === 'rerun' ? { feedback: 'Fix feedback' } : {}) });
      }
    });

    it('claims only the blocked todo still owned by this failed run and prevents duplicate retries', async () => {
      const todos = openTodoStore(':memory:');
      try {
        const todo = todos.create({ title: 'Fix it', repo: 'o/r', description: 'Task requirements' });
        todos.claim(todo.id, 'failed-run');
        todos.finishRun('failed-run', 'failed');
        const launch = vi.fn<RouterDeps['launch']>(body => {
          expect(todos.claim(body.todoId!, 'fresh-run', body.retryOf)).not.toBeNull();
          return 'fresh-run';
        });
        const local = { ...deps, todos, launch, jiraEnabled: () => false, db: { ...deps.db, getRun: () => failed({ taskJson: JSON.stringify({ todoId: todo.id, task: 'old text' }) }) } };
        expect((await retry({ ...local, jiraEnabled: () => true }))?.status).toBe(409);
        expect(await retry(local)).toEqual({ status: 200, json: { runId: 'fresh-run' } });
        expect((await retry(local))?.status).toBe(409);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(todos.get(todo.id)).toMatchObject({ runId: 'fresh-run', state: 'in_progress' });
      } finally { todos.close(); }
    });
  });

  it('returns paginated run summaries and counts with bounded defaults', async () => {
    const row = deps.db.listRuns(1)[0]!;
    const runPage = vi.fn().mockReturnValue({ runs: [row], total: 101 });
    const historyDeps = { ...deps, db: { ...deps.db, runPage } };
    expect(await handleApi('GET', '/api/runs', new URLSearchParams(), null, historyDeps))
      .toMatchObject({ status: 200, json: { runs: [{ id: row.id }], total: 101, limit: 25, offset: 0 } });
    expect(runPage).toHaveBeenLastCalledWith(25, 0, null);
    await handleApi('GET', '/api/runs', new URLSearchParams('limit=10&offset=50&repo=owner/repo'), null, historyDeps);
    expect(runPage).toHaveBeenLastCalledWith(10, 50, 'owner/repo');
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'offset=-1', 'offset=NaN', 'offset=1e3', 'offset=9007199254740992', 'repo=../invalid'])('rejects invalid history query %s', async (query) => {
    const runPage = vi.fn();
    expect(await handleApi('GET', '/api/runs', new URLSearchParams(query), null, { ...deps, db: { ...deps.db, runPage } }))
      .toMatchObject({ status: 400 });
    expect(runPage).not.toHaveBeenCalled();
  });

  it('posts Slack review requests only from the explicit endpoint and preserves uncertain delivery errors', async () => {
    const body = { repo: 'o/r', prNumber: 5, requestId: 'request-id' };
    const receipt = { ok: true as const, channel: 'airo-editing', mention: 'airo-editing-squad', permalink: null };
    const request = vi.fn().mockResolvedValue(receipt);
    expect(await handleApi('POST', '/api/slack/review-request', new URLSearchParams(), body, { ...deps, slackReviewRequest: request }))
      .toEqual({ status: 200, json: receipt });
    expect(request).toHaveBeenCalledWith(body);
    expect(await handleApi('POST', '/api/slack/review-request', new URLSearchParams(), body, deps))
      .toMatchObject({ status: 503 });
    request.mockRejectedValue(new SlackReviewError('Check Slack before retrying.', 502, true));
    expect(await handleApi('POST', '/api/slack/review-request', new URLSearchParams(), body, { ...deps, slackReviewRequest: request }))
      .toEqual({ status: 502, json: { error: 'Check Slack before retrying.', uncertain: true } });
  });

  it('loads navigation context from local configuration', async () => {
    const value = { repos: ['o/r'], jiraBaseUrl: 'https://x.atlassian.net' };
    const dashboard = vi.fn();
    expect(await handleApi('GET', '/api/context', new URLSearchParams(), null, { ...deps, dashboard, context: () => value }))
      .toEqual({ status: 200, json: value });
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('exposes external usage without generating external requests', async () => {
    const outboundUsage = vi.fn(() => ({ totals: { started: 3 } }));
    expect(await handleApi('GET', '/api/usage/external', new URLSearchParams(), null, { ...deps, outboundUsage }))
      .toEqual({ status: 200, json: { totals: { started: 3 } } });
    expect(outboundUsage).toHaveBeenCalledTimes(1);
  });

  it('routes explicit local Git actions and preserves safety rejections', async () => {
    const localGitAction = vi.fn().mockResolvedValue({ status: 409, json: { error: 'Worktree is in use.' } });
    const body = { repo: 'o/r', action: 'delete-worktree', path: '/agents/r/.worktrees/run', expectedCommit: 'a'.repeat(40) };
    expect(await handleApi('POST', '/api/repo/local', new URLSearchParams(), body, { ...deps, localGitAction }))
      .toEqual({ status: 409, json: { error: 'Worktree is in use.' } });
    expect(localGitAction).toHaveBeenCalledWith('o/r', body);
    for (const invalid of [null, [], { repo: '../outside' }, { repo: 1 }]) {
      expect((await handleApi('POST', '/api/repo/local', new URLSearchParams(), invalid, { ...deps, localGitAction }))?.status).toBe(400);
    }
    expect(localGitAction).toHaveBeenCalledTimes(1);
  });

  it('returns durable Slack state and marks only existing notifications read', async () => {
    const snapshot = { health: { enabled: false, status: 'disabled' as const, channelName: 'airo-editing', intervalMs: 300000, lastSuccessAt: null, error: null }, notifications: [] };
    const markRead = vi.fn((id: string) => id === 'known');
    const withSlack = { ...deps, slack: { snapshot: () => snapshot, markRead } };
    expect(await handleApi('GET', '/api/slack', new URLSearchParams(), null, withSlack)).toEqual({ status: 200, json: snapshot });
    expect(await handleApi('POST', '/api/slack/notifications/known/read', new URLSearchParams(), null, withSlack)).toEqual({ status: 200, json: { ok: true } });
    expect((await handleApi('POST', '/api/slack/notifications/missing/read', new URLSearchParams(), null, withSlack))?.status).toBe(404);
    expect((await handleApi('GET', '/api/slack/notifications/known/read', new URLSearchParams(), null, withSlack))?.status).toBe(404);
    expect(markRead).toHaveBeenCalledTimes(2);
  });
  it('routes local checkout requests and preserves unknown-repository responses', async () => {
    const response = { status: 404, json: { error: 'Galleon is not configured.' } };
    const localGit = vi.fn().mockResolvedValue(response);
    expect(await handleApi('GET', '/api/repo/local', new URLSearchParams({ repo: 'o/r' }), null, { ...deps, localGit })).toEqual(response);
    expect(localGit).toHaveBeenCalledWith('o/r');
  });

  it.each(['', 'owner', 'o/..', '../repo', 'o/r/extra', '/tmp/repo', 'o/r?x=y'])('rejects invalid local checkout repo %s', async (repo) => {
    const localGit = vi.fn();
    expect((await handleApi('GET', '/api/repo/local', new URLSearchParams({ repo }), null, { ...deps, localGit }))?.status).toBe(400);
    expect(localGit).not.toHaveBeenCalled();
  });

  it('routes review requests globally or for a selected repository and preserves partial status', async () => {
    const result = { prs: [], degraded: true, truncated: true };
    const reviewRequestedPrs = vi.fn().mockResolvedValue(result);
    for (const repo of [null, 'o/r']) {
      const response = await handleApi('GET', '/api/pr/review-requests', new URLSearchParams(repo ? { repo } : {}), null, { ...deps, reviewRequestedPrs });
      expect(reviewRequestedPrs).toHaveBeenLastCalledWith(repo);
      expect(response).toEqual({ status: 200, json: result });
    }
  });

  it('routes repository open PRs and validates required repository names', async () => {
    const repoOpenPrs = vi.fn().mockResolvedValue({ prs: [], degraded: false, truncated: false });
    const response = await handleApi('GET', '/api/pr/open', new URLSearchParams('repo=o/r'), null, { ...deps, repoOpenPrs });
    expect(response?.status).toBe(200);
    expect(repoOpenPrs).toHaveBeenCalledWith('o/r');
    for (const repo of ['', 'owner', 'o/r/extra', 'o/..', 'o/r?state=closed']) {
      for (const path of ['/api/pr/open', '/api/pr/review-requests']) {
        expect((await handleApi('GET', path, new URLSearchParams({ repo }), null, deps))?.status).toBe(400);
      }
    }
    expect((await handleApi('GET', '/api/pr/open', new URLSearchParams(), null, deps))?.status).toBe(400);
  });

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

  it('routes GET /api/bugs to the bugs dep with the repo query', async () => {
    let seen: string | null | undefined;
    const res = await handleApi('GET', '/api/bugs', new URLSearchParams('repo=o/a'), null, {
      ...deps,
      bugs: async (repo: string | null) => { seen = repo; return { cards: [], degraded: false, generatedAt: 'now', latestWindow: 'a', previousWindow: 'b' }; },
    });
    expect(seen).toBe('o/a');
    expect(res).toEqual({ status: 200, json: { cards: [], degraded: false, generatedAt: 'now', latestWindow: 'a', previousWindow: 'b' } });
  });

  it('lists runs', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it.each([
    ['Approve', 'APPROVE'],
    ['Request changes', 'REQUEST_CHANGES'],
    ['Comment only', 'COMMENT'],
  ])('includes persisted %s recommendations on list and detail summaries', async (label, reviewOutcome) => {
    const row = { ...deps.db.listRuns(1)[0]!, status: 'succeeded' as const };
    const reviewVerdict = `Verdict: ${label} — Review result.`;
    const latestReviewVerdict = vi.fn(() => reviewVerdict);
    const listEvents = vi.fn();
    const reviewDeps = { ...deps, db: { ...deps.db, listRuns: () => [row], getRun: () => row, latestReviewVerdict, listEvents } };
    const list = await handleApi('GET', '/api/agents', new URLSearchParams(), null, reviewDeps);
    const detail = await handleApi('GET', '/api/agents/r1', new URLSearchParams(), null, reviewDeps);
    expect((list?.json as { runs: unknown[] }).runs[0]).toMatchObject({ reviewOutcome, reviewVerdict });
    expect(detail?.json).toMatchObject({ reviewOutcome, reviewVerdict });
    expect(latestReviewVerdict).toHaveBeenCalledWith('r1');
    expect(listEvents).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed', 'stopped'] as const)('does not expose a final review recommendation on a %s run', async (status) => {
    const row = { ...deps.db.listRuns(1)[0]!, status };
    const latestReviewVerdict = vi.fn(() => 'Verdict: Approve — Ready.');
    const result = await handleApi('GET', '/api/agents', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, listRuns: () => [row], latestReviewVerdict },
    });
    const summary = (result?.json as { runs: unknown[] }).runs[0];
    expect(summary).not.toHaveProperty('reviewOutcome');
    expect(summary).not.toHaveProperty('reviewVerdict');
    expect(latestReviewVerdict).not.toHaveBeenCalled();
  });

  it.each([null, '', 'Verdict: Unknown — Ready.', 'Verdict: Approve — ', 'Approve'])('omits absent or unrecognized review verdict %s', async (verdict) => {
    const row = { ...deps.db.listRuns(1)[0]!, status: 'succeeded' as const };
    const result = await handleApi('GET', '/api/agents/r1', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun: () => row, latestReviewVerdict: () => verdict },
    });
    expect(result?.json).not.toHaveProperty('reviewOutcome');
    expect(result?.json).not.toHaveProperty('reviewVerdict');
  });

  it('retrieves an older run directly without the recent-list limit or internal fields', async () => {
    const getRun = vi.fn().mockReturnValue({
      id: 'old-run', ticketId: 'T-1', repo: 'o/r', status: 'succeeded', attempt: 1,
      prNumber: 42, startedAt: '2025-01-01T00:00:00Z', costUsd: null,
      worktreePath: '/private/checkout', specPath: '/private/env.json', taskJson: 'private task',
    });
    const listRuns = vi.fn().mockReturnValue([]);
    const r = await handleApi('GET', '/api/agents/old-run', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun, listRuns },
    });
    expect(getRun).toHaveBeenCalledWith('old-run');
    expect(listRuns).not.toHaveBeenCalled();
    expect(r).toEqual({ status: 200, json: {
      id: 'old-run', ticketId: 'T-1', repo: 'o/r', status: 'succeeded', attempt: 1,
      prNumber: 42, startedAt: '2025-01-01T00:00:00Z', costUsd: null,
    } });
  });

  it('returns 404 for a missing run', async () => {
    const r = await handleApi('GET', '/api/agents/missing-run', new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun: () => null },
    });
    expect(r).toEqual({ status: 404, json: { error: 'run not found' } });
  });

  it.each(['bad%20id', 'bad.id', 'x'.repeat(129)])('rejects invalid run IDs before querying: %s', async (id) => {
    const getRun = vi.fn();
    const r = await handleApi('GET', `/api/agents/${id}`, new URLSearchParams(), null, {
      ...deps, db: { ...deps.db, getRun },
    });
    expect(r?.status).toBe(400);
    expect(getRun).not.toHaveBeenCalled();
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

  it('rejects launch when capacity blocks it', async () => {
    const blocked = { ...launchDeps, canStart: () => ({ ok: false, reason: 'busy' }) } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, blocked);
    expect(r?.status).toBe(409);
  });

  it('returns a conflict when a task or branch reservation blocks launch', async () => {
    const blocked = { ...launchDeps, launch: () => { throw new RunConflictError('a run is already active for ticket T-1'); } };
    const result = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', repo: 'o/r' }, blocked);
    expect(result).toEqual({ status: 409, json: { error: 'a run is already active for ticket T-1' } });
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
    expect(r?.json).toEqual({ error: 'Galleon required' });
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
      jiraTokenSet: true,
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
    expect(r?.json).toEqual({ error: 'Galleon and PR number required' });
  });

  it('rejects a request with a non-numeric number', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=x'), null, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'Galleon and PR number required' });
  });

  it('rejects a request missing repo', async () => {
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('number=5'), null, deps);
    expect(r?.status).toBe(400);
    expect(r?.json).toEqual({ error: 'Galleon and PR number required' });
  });

  it('returns 404 when the PR is not found or GitHub is not configured', async () => {
    const notFoundDeps = { ...deps, prStatus: async (_repo: string, _n: number) => null } as unknown as RouterDeps;
    const r = await handleApi('GET', '/api/pr', new URLSearchParams('repo=o/r&number=5'), null, notFoundDeps);
    expect(r?.status).toBe(404);
    expect(r?.json).toEqual({ error: 'PR not found or GitHub not configured' });
  });

  it('GET /api/pr/diff returns the per-file diff', async () => {
    const r = await handleApi('GET', '/api/pr/diff', new URLSearchParams('repo=o/r&number=5'), null, deps);
    expect(r?.status).toBe(200);
    expect(r?.json).toEqual({ files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ x @@' }] });
  });

  it('GET /api/pr/diff validates params and 404s when unavailable', async () => {
    expect((await handleApi('GET', '/api/pr/diff', new URLSearchParams('repo=o/r'), null, deps))?.status).toBe(400);
    const nullDeps = { ...deps, prDiff: async (_r: string, _n: number) => null } as unknown as RouterDeps;
    const r = await handleApi('GET', '/api/pr/diff', new URLSearchParams('repo=o/r&number=5'), null, nullDeps);
    expect(r?.status).toBe(404);
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
        return Promise.resolve({ ok: true, path: '/tmp/helmsman-clip-x.png' });
      },
    });
    const bad = await handleApi('POST', '/api/cmux/paste-image', new URLSearchParams(), { surface: 'surface:1' }, cmuxDeps);
    expect(bad?.status).toBe(400);
    const ok = await handleApi('POST', '/api/cmux/paste-image', new URLSearchParams(), { surface: 'surface:1', dataBase64: 'aGk=', ext: 'png' }, cmuxDeps);
    expect(ok?.status).toBe(200);
    expect((ok?.json as { path?: string }).path).toBe('/tmp/helmsman-clip-x.png');
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

let todoStore: TodoStore | undefined;
afterEach(() => todoStore?.close());

describe('todo API', () => {
  it('validates CRUD and enforces source mode on mutations', async () => {
    todoStore = openTodoStore(':memory:');
    const local = { ...deps, todos: todoStore, jiraEnabled: () => false };
    const call = (method: string, path: string, body: unknown = null) => handleApi(method, path, new URLSearchParams(), body, local);
    expect((await call('POST', '/api/todos', { title: '', repo: 'o/r' }))?.status).toBe(400);
    const created = await call('POST', '/api/todos', { title: 'Do work', repo: 'o/r', description: 'Requirements' });
    expect(created?.status).toBe(201);
    const id = todoStore.list()[0]?.id ?? '';
    expect((await call('PUT', `/api/todos/${id}`, { priority: 'P0' }))?.status).toBe(200);
    expect(todoStore.get(id)?.priority).toBe('P0');
    const enabled = { ...local, jiraEnabled: () => true };
    expect((await handleApi('POST', '/api/todos', new URLSearchParams(), { title: 'More', repo: 'o/r' }, enabled))?.status).toBe(409);
    expect((await call('GET', '/api/todos'))?.json).toMatchObject({ jiraEnabled: false, todos: [{ id }] });
    expect((await call('DELETE', `/api/todos/${id}`))?.status).toBe(200);
    expect((await call('DELETE', `/api/todos/${id}`))?.status).toBe(404);
  });

  it('launches from authoritative todo identity and rejects stale or incomplete tasks', async () => {
    todoStore = openTodoStore(':memory:');
    const todo = todoStore.create({ title: 'Actual title', repo: 'actual/repo', description: 'Requirements' });
    const launch = vi.fn(() => 'run-todo');
    const canStart = vi.fn(() => ({ ok: true }));
    const local = { ...deps, todos: todoStore, jiraEnabled: () => false, launch, canStart };
    const body = { mode: 'todo', todoId: todo.id, repo: 'spoofed/repo', title: 'Spoofed', task: 'Ignore actual task' };
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local))?.status).toBe(200);
    expect(canStart).toHaveBeenCalledWith('actual/repo');
    expect(launch).toHaveBeenCalledWith({ mode: 'todo', todoId: todo.id, repo: 'actual/repo', model: undefined, effort: undefined });
    todoStore.claim(todo.id, 'run-todo');
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, local))?.status).toBe(409);
    expect((await handleApi('PUT', `/api/todos/${todo.id}`, new URLSearchParams(), { title: 'Busy' }, local))?.status).toBe(409);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'JIRA-1', repo: 'o/r' }, local))?.status).toBe(409);
    expect((await handleApi('POST', '/api/agents/launch', new URLSearchParams(), body, { ...local, jiraEnabled: () => true }))?.status).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

it('rejects stale local queue launches through the Jira route after re-enabling Jira', async () => {
  todoStore = openTodoStore(':memory:');
  const todo = todoStore.create({ title: 'Local', repo: 'o/r', description: 'Requirements' });
  const launch = vi.fn(() => 'should-not-launch');
  const result = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: todo.id, repo: todo.repo }, { ...deps, todos: todoStore, jiraEnabled: () => true, launch });
  expect(result?.status).toBe(409);
  expect(launch).not.toHaveBeenCalled();
});

describe('ticket assignment', () => {
  it('assigns to the authenticated user without launching a run', async () => {
    const assignTicket = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn();
    const result = await handleApi('POST', '/api/tickets/AB-123/assign-self', new URLSearchParams(), null, { ...deps, assignTicket, launch });
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(assignTicket).toHaveBeenCalledWith('AB-123');
    expect(launch).not.toHaveBeenCalled();
  });
  it('reports assignment errors and rejects disabled Jira', async () => {
    const assignTicket = vi.fn().mockRejectedValue(new Error('Jira assignment failed (403).'));
    const request = (jiraEnabled: () => boolean) => handleApi('POST', '/api/tickets/AB-123/assign-self', new URLSearchParams(), null, { ...deps, assignTicket, jiraEnabled });
    expect(await request(() => true)).toEqual({ status: 502, json: { error: 'Jira assignment failed (403).' } });
    expect((await request(() => false))?.status).toBe(409);
    expect(assignTicket).toHaveBeenCalledTimes(1);
  });
});
