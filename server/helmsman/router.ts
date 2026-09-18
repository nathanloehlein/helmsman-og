import { TodoConflictError, TodoValidationError, type TodoStore } from './todos';
import { SlackReviewError, type SlackReviewResult } from './slack/review-request';
import type { Db, RunRow } from './db';
import type { PrStatus } from '../github';
import { isGithubRepo, type PrListResponse } from '../pr-lists';
import type { TriageResponse } from '../triage-endpoint';
import type { BugsResponse, PrFileDiff } from '../../src/types';
import type { CmuxTab } from './cmux/model';
import { isAllowedKey } from './cmux/keys';
import type { SlackState } from '../../src/data/slack';
import { retryIntent, RetryError, type LaunchIntent } from './retry';

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface RunSummary {
  id: string;
  ticketId: string;
  repo: string;
  status: string;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  costUsd: number | null;
  reviewOutcome?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  reviewVerdict?: string;
}

function toRunSummary(row: RunRow, db: Db): RunSummary {
  const reviewVerdict = row.status === 'succeeded' ? db.latestReviewVerdict(row.id) : null;
  const verdictLabel = reviewVerdict?.match(/^Verdict: (Approve|Request changes|Comment only) — \S/)?.[1];
  const reviewOutcome = verdictLabel === 'Approve' ? 'APPROVE'
    : verdictLabel === 'Request changes' ? 'REQUEST_CHANGES'
    : verdictLabel === 'Comment only' ? 'COMMENT' : undefined;
  return {
    id: row.id,
    ticketId: row.ticketId,
    repo: row.repo,
    status: row.status,
    attempt: row.attempt,
    prNumber: row.prNumber,
    startedAt: row.startedAt,
    costUsd: row.costUsd,
    ...(reviewOutcome && reviewVerdict ? { reviewOutcome, reviewVerdict } : {}),
  };
}

export interface RouterDeps {
  slackReviewRequest?: (input: unknown) => Promise<SlackReviewResult>;
  todos?: TodoStore;
  jiraEnabled?: () => boolean;
  outboundUsage?: () => unknown;
  context?: () => { repos: string[]; jiraBaseUrl: string | null; jiraEnabled?: boolean };
  slack?: { snapshot: () => SlackState; markRead: (id: string) => boolean };
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  triage: (repo: string | null) => Promise<TriageResponse>;
  bugs: (repo: string | null) => Promise<BugsResponse>;
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: LaunchIntent & { retryOf?: string }) => string;
  stop: (runId: string) => boolean;
  setAutoClaim: (repo: string, enabled: boolean) => void;
  autoClaimRepos: () => string[];
  caps: () => { maxAttempts: number; maxCostUsd: number | null };
  getConfig: () => { config: Record<string, unknown>; overridden: string[]; jiraTokenSet: boolean; slackTokenSet?: boolean };
  setConfig: (key: string, value: string) => { ok: true } | { ok: false; error: string };
  prStatus: (repo: string, prNumber: number) => Promise<PrStatus | null>;
  reviewRequestedPrs: (repo: string | null) => Promise<PrListResponse>;
  repoOpenPrs: (repo: string) => Promise<PrListResponse>;
  localGit: (repo: string) => Promise<ApiResult>;
  localGitAction?: (repo: string, body: unknown) => Promise<ApiResult>;
  prDiff: (repo: string, prNumber: number) => Promise<PrFileDiff[] | null>;
  submitReview: (
    repo: string,
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  cmuxListTabs: () => Promise<{ connected: boolean; tabs: CmuxTab[] }>;
  cmuxReadScreen: (surface: string, lines: number) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  cmuxSend: (surface: string, text: string, enter: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  cmuxPasteImage: (surface: string, dataBase64: string, ext: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  cmuxAction: (surface: string, provider: string | null, action: string) => Promise<{ ok: true; keys: string[] } | { ok: false; error: string }>;
  cmuxKey: (surface: string, key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export async function handleApi(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: unknown,
  deps: RouterDeps,
): Promise<ApiResult | null> {
  if (path === '/api/slack/review-request' && method === 'POST') {
    if (!deps.slackReviewRequest) return { status: 503, json: { error: 'Slack review requests are unavailable.' } };
    try {
      return { status: 200, json: await deps.slackReviewRequest(_body) };
    } catch (error) {
      if (error instanceof SlackReviewError) return { status: error.status, json: { error: error.message, uncertain: error.uncertain } };
      return { status: 502, json: { error: 'Slack review request failed. Check Slack before retrying.', uncertain: true } };
    }
  }
  const todoMatch = path.match(/^\/api\/todos\/(TODO-[1-9]\d*)$/);
  if (path === '/api/todos' || todoMatch) {
    if (!deps.todos) return { status: 503, json: { error: 'Todos unavailable.' } };
    const jiraEnabled = deps.jiraEnabled?.() ?? true;
    if (method === 'GET' && path === '/api/todos') return { status: 200, json: { todos: deps.todos.list(), jiraEnabled } };
    if (method === 'GET' && todoMatch) {
      const todo = deps.todos.get(todoMatch[1]);
      return todo ? { status: 200, json: { todo } } : { status: 404, json: { error: 'Todo not found.' } };
    }
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      if (jiraEnabled) return { status: 409, json: { error: 'Disable Jira in Config to manage todos.' } };
      try {
        if (method === 'POST' && path === '/api/todos') return { status: 201, json: { todo: deps.todos.create(_body) } };
        if (method === 'PUT' && todoMatch) {
          const todo = deps.todos.update(todoMatch[1], _body);
          return todo ? { status: 200, json: { todo } } : { status: 404, json: { error: 'Todo not found.' } };
        }
        if (method === 'DELETE' && todoMatch) {
          return deps.todos.remove(todoMatch[1]) ? { status: 200, json: { ok: true } } : { status: 404, json: { error: 'Todo not found.' } };
        }
      } catch (error) {
        if (error instanceof TodoValidationError || error instanceof TodoConflictError) {
          return { status: error instanceof TodoConflictError ? 409 : 400, json: { error: error.message } };
        }
        throw error;
      }
    }
    return { status: 404, json: { error: 'not found' } };
  }
  if (path === '/api/context' && method === 'GET') {
    return deps.context ? { status: 200, json: deps.context() } : { status: 503, json: { error: 'Context unavailable.' } };
  }
  if (path === '/api/usage/external' && method === 'GET') {
    return { status: 200, json: deps.outboundUsage?.() ?? null };
  }
  if (path === '/api/slack' && method === 'GET') {
    return { status: 200, json: deps.slack?.snapshot() ?? {
      health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null },
      notifications: [],
    } };
  }
  const slackRead = path.match(/^\/api\/slack\/notifications\/([a-z\d_-]{1,128})\/read$/i);
  if (slackRead && method === 'POST') {
    const ok = deps.slack?.markRead(slackRead[1]) ?? false;
    return { status: ok ? 200 : 404, json: ok ? { ok: true } : { error: 'notification not found' } };
  }
  if (path === '/api/dashboard' && method === 'GET') {
    const payload = await deps.dashboard(query.get('repo'));
    return { status: 200, json: payload };
  }
  if (path === '/api/triage' && method === 'GET') {
    return { status: 200, json: await deps.triage(query.get('repo')) };
  }
  if (path === '/api/bugs' && method === 'GET') {
    return { status: 200, json: await deps.bugs(query.get('repo')) };
  }
  if (path === '/api/agents' && method === 'GET') {
    return { status: 200, json: { runs: deps.db.listRuns(50).map((row) => toRunSummary(row, deps.db)), autoClaim: deps.autoClaimRepos(), caps: deps.caps() } };
  }
  if (path === '/api/runs' && method === 'GET') {
    const rawLimit = query.get('limit') ?? '25';
    const rawOffset = query.get('offset') ?? '0';
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const repo = query.get('repo');
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100
      || !/^(?:0|[1-9]\d*)$/.test(rawOffset) || !Number.isSafeInteger(offset)
      || repo !== null && !isGithubRepo(repo)) {
      return { status: 400, json: { error: 'Use a limit from 1 to 100, a nonnegative offset, and an optional owner/repo filter.' } };
    }
    const page = deps.db.runPage(limit, offset, repo);
    return { status: 200, json: { runs: page.runs.map((row) => toRunSummary(row, deps.db)), total: page.total, limit, offset } };
  }
  const runMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const runId = runMatch[1];
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId)) return { status: 400, json: { error: 'invalid run ID' } };
    const run = deps.db.getRun(runId);
    return run ? { status: 200, json: toRunSummary(run, deps.db) } : { status: 404, json: { error: 'run not found' } };
  }
  const retryMatch = path.match(/^\/api\/agents\/([^/]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    const runId = retryMatch[1];
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId)) return { status: 400, json: { error: 'invalid run ID' } };
    const run = deps.db.getRun(runId);
    if (!run) return { status: 404, json: { error: 'Voyage not found.' } };
    try {
      const intent = retryIntent(run);
      const allowed = deps.context?.().repos;
      if (allowed && !allowed.some(repo => repo.toLowerCase() === intent.repo.toLowerCase())) {
        return { status: 409, json: { error: 'This repository is no longer configured. Configure it before retrying the voyage.' } };
      }
      const gate = deps.canStart(intent.repo);
      if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'Cannot start another voyage.' } };
      if (intent.mode === 'todo') {
        if (deps.jiraEnabled?.() !== false) return { status: 409, json: { error: 'Disable Jira in Config to retry a todo voyage.' } };
        const todo = intent.todoId ? deps.todos?.get(intent.todoId) : null;
        if (!todo || todo.repo !== run.repo || todo.runId !== run.id || !['todo', 'blocked'].includes(todo.state) || !todo.description.trim()) {
          return { status: 409, json: { error: 'The todo must still belong to this failed voyage, have a description, and be To do or Blocked. Start changed or completed todos from Todos.' } };
        }
      } else if (intent.mode === 'ticket' && deps.jiraEnabled?.() === false) {
        return { status: 409, json: { error: 'Enable Jira in Config before retrying a Jira voyage.' } };
      }
      return { status: 200, json: { runId: deps.launch({ ...intent, retryOf: run.id }) } };
    } catch (error) {
      if (error instanceof RetryError || error instanceof TodoConflictError || error instanceof TodoValidationError) {
        return { status: 409, json: { error: error.message } };
      }
      throw error;
    }
  }
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { todoId?: string; ticketId?: string; title?: string; repo?: string; task?: string; mode?: string; prNumber?: number; feedback?: string; model?: string; effort?: string } | null;
    if (b?.mode === 'todo') {
      if (deps.jiraEnabled?.() !== false) return { status: 409, json: { error: 'Disable Jira in Config to launch todos.' } };
      if (typeof b.todoId !== 'string') return { status: 400, json: { error: 'todoId required' } };
      const todo = deps.todos?.get(b.todoId);
      if (!todo) return { status: 404, json: { error: 'Todo not found.' } };
      if (todo.state !== 'todo' || !todo.description.trim()) return { status: 409, json: { error: 'Todo must be in To do with a description before starting a voyage.' } };
      const gate = deps.canStart(todo.repo);
      if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
      try {
        const runId = deps.launch({ mode: 'todo', todoId: todo.id, repo: todo.repo, model: b.model, effort: b.effort });
        return { status: 200, json: { runId } };
      } catch (error) {
        if (error instanceof TodoConflictError || error instanceof TodoValidationError) return { status: error instanceof TodoConflictError ? 409 : 400, json: { error: error.message } };
        throw error;
      }
    }
    if (typeof b?.repo !== 'string' || !b.repo.trim()) return { status: 400, json: { error: 'repo required' } };
    const gate = deps.canStart(b.repo);
    if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
    const tuning: { model?: string; effort?: string } = { model: b.model, effort: b.effort };
    if (b.mode === 'rerun') {
      if (typeof b.prNumber !== 'number' || !Number.isFinite(b.prNumber)) return { status: 400, json: { error: 'repo and prNumber required' } };
      const runId: string = deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'rerun', feedback: b.feedback, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'review') {
      if (typeof b.prNumber !== 'number' || !Number.isFinite(b.prNumber)) return { status: 400, json: { error: 'repo and prNumber required' } };
      const runId: string = deps.launch({ repo: b.repo, prNumber: b.prNumber, mode: 'review', ...tuning });
      return { status: 200, json: { runId } };
    }
    if (b.mode === 'freeform') {
      if (!b.task) return { status: 400, json: { error: 'task required' } };
      const runId = deps.launch({ repo: b.repo, task: b.task, ...tuning });
      return { status: 200, json: { runId } };
    }
    if (typeof b.ticketId === 'string' && deps.todos?.get(b.ticketId)) return { status: 409, json: { error: 'Local todos must be launched from Todos with Jira disabled.' } };
    if (deps.jiraEnabled?.() === false) return { status: 409, json: { error: 'Jira is disabled. Start a voyage from Todos.' } };
    if (!b.ticketId) return { status: 400, json: { error: 'ticketId and repo required' } };
    const runId = deps.launch({ ticketId: b.ticketId, title: b.title, repo: b.repo, ...tuning });
    return { status: 200, json: { runId } };
  }
  const stopMatch: RegExpMatchArray | null = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return { status: 200, json: { stopped: deps.stop(stopMatch[1]) } };
  }
  const autoClaimMatch: RegExpMatchArray | null = path.match(/^\/api\/repos\/(.+)\/auto-claim$/);
  if (autoClaimMatch && method === 'POST') {
    const repo: string = decodeURIComponent(autoClaimMatch[1]);
    const enabled: boolean = (_body as { enabled?: boolean } | null)?.enabled === true;
    deps.setAutoClaim(repo, enabled);
    return { status: 200, json: { repo, enabled } };
  }
  if (path === '/api/config' && method === 'GET') {
    return { status: 200, json: deps.getConfig() };
  }
  if (path === '/api/config' && method === 'PUT') {
    const b: { key?: string; value?: string } | null = _body as { key?: string; value?: string } | null;
    if (typeof b?.key !== 'string' || typeof b?.value !== 'string') {
      return { status: 400, json: { error: 'key and value required' } };
    }
    const r: { ok: true } | { ok: false; error: string } = deps.setConfig(b.key, b.value);
    return r.ok ? { status: 200, json: { key: b.key, value: b.value } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/pr/review-requests' && method === 'GET') {
    const repo: string | null = query.get('repo');
    if (repo !== null && !isGithubRepo(repo)) return { status: 400, json: { error: 'repo must be owner/name' } };
    return { status: 200, json: await deps.reviewRequestedPrs(repo) };
  }
  if (path === '/api/pr/open' && method === 'GET') {
    const repo: string | null = query.get('repo');
    if (!repo || !isGithubRepo(repo)) return { status: 400, json: { error: 'repo must be owner/name' } };
    return { status: 200, json: await deps.repoOpenPrs(repo) };
  }
  if (path === '/api/repo/local' && method === 'POST') {
    const body = _body && typeof _body === 'object' && !Array.isArray(_body) ? _body as Record<string, unknown> : null;
    if (typeof body?.repo !== 'string' || !isGithubRepo(body.repo)) return { status: 400, json: { error: 'repo must be owner/name' } };
    if (!deps.localGitAction) return { status: 503, json: { error: 'Local Git actions are unavailable.' } };
    return deps.localGitAction(body.repo, body);
  }
  if (path === '/api/repo/local' && method === 'GET') {
    const repo = query.get('repo');
    if (!repo || !isGithubRepo(repo)) return { status: 400, json: { error: 'repo must be owner/name' } };
    return deps.localGit(repo);
  }
  if (path === '/api/pr' && method === 'GET') {
    const repo: string | null = query.get('repo');
    const numRaw: string | null = query.get('number');
    const n: number = Number(numRaw);
    if (!repo || !numRaw || !Number.isFinite(n)) {
      return { status: 400, json: { error: 'repo and number required' } };
    }
    const s: PrStatus | null = await deps.prStatus(repo, n);
    return s ? { status: 200, json: s } : { status: 404, json: { error: 'PR not found or GitHub not configured' } };
  }
  if (path === '/api/pr/diff' && method === 'GET') {
    const repo: string | null = query.get('repo');
    const numRaw: string | null = query.get('number');
    const n: number = Number(numRaw);
    if (!repo || !numRaw || !Number.isFinite(n)) {
      return { status: 400, json: { error: 'repo and number required' } };
    }
    const files: PrFileDiff[] | null = await deps.prDiff(repo, n);
    return files ? { status: 200, json: { files } } : { status: 404, json: { error: 'PR diff not found or GitHub not configured' } };
  }
  if (path === '/api/pr/review' && method === 'POST') {
    const b: { repo?: string; number?: number; event?: string; body?: string } | null = _body as
      | { repo?: string; number?: number; event?: string; body?: string }
      | null;
    const EVENTS: string[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
    if (
      typeof b?.repo !== 'string' ||
      typeof b?.number !== 'number' ||
      !Number.isFinite(b.number) ||
      typeof b?.event !== 'string' ||
      !EVENTS.includes(b.event)
    ) {
      return { status: 400, json: { error: 'repo, number, and a valid event are required' } };
    }
    if ((b.event === 'REQUEST_CHANGES' || b.event === 'COMMENT') && (typeof b.body !== 'string' || b.body.trim() === '')) {
      return { status: 400, json: { error: 'body required for this review event' } };
    }
    const r: { ok: true } | { ok: false; error: string } = await deps.submitReview(
      b.repo,
      b.number,
      b.event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      b.body ?? '',
    );
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/tabs' && method === 'GET') {
    return { status: 200, json: await deps.cmuxListTabs() };
  }
  if (path === '/api/cmux/screen' && method === 'GET') {
    const surface: string | null = query.get('surface');
    if (!surface) return { status: 400, json: { error: 'surface required' } };
    const lines: number = Number(query.get('lines') ?? '40');
    const r = await deps.cmuxReadScreen(surface, Number.isFinite(lines) ? lines : 40);
    return r.ok ? { status: 200, json: { surface, text: r.text } } : { status: 404, json: { error: r.error } };
  }
  if (path === '/api/cmux/send' && method === 'POST') {
    const b = _body as { surface?: string; text?: string; enter?: boolean } | null;
    if (typeof b?.surface !== 'string' || typeof b?.text !== 'string') {
      return { status: 400, json: { error: 'surface and text required' } };
    }
    const r = await deps.cmuxSend(b.surface, b.text, b.enter === true);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/paste-image' && method === 'POST') {
    const b = _body as { surface?: string; dataBase64?: string; ext?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.dataBase64 !== 'string') {
      return { status: 400, json: { error: 'surface and dataBase64 required' } };
    }
    const r = await deps.cmuxPasteImage(b.surface, b.dataBase64, typeof b.ext === 'string' ? b.ext : 'png');
    return r.ok ? { status: 200, json: { ok: true, path: r.path } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/action' && method === 'POST') {
    const b = _body as { surface?: string; provider?: string | null; action?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.action !== 'string') {
      return { status: 400, json: { error: 'surface and action required' } };
    }
    const r = await deps.cmuxAction(b.surface, b.provider ?? null, b.action);
    return r.ok ? { status: 200, json: { ok: true, keys: r.keys } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/key' && method === 'POST') {
    const b = _body as { surface?: string; key?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.key !== 'string') {
      return { status: 400, json: { error: 'surface and key required' } };
    }
    if (!isAllowedKey(b.key)) {
      return { status: 400, json: { error: 'unsupported key' } };
    }
    const r = await deps.cmuxKey(b.surface, b.key);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
