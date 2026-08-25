import type { Db, RunRow } from './db';
import type { PrStatus } from '../github';

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
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    ticketId: row.ticketId,
    repo: row.repo,
    status: row.status,
    attempt: row.attempt,
    prNumber: row.prNumber,
    startedAt: row.startedAt,
    costUsd: row.costUsd,
  };
}

export interface RouterDeps {
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: { ticketId?: string; title?: string; repo: string; task?: string }) => string;
  stop: (runId: string) => boolean;
  setAutoClaim: (repo: string, enabled: boolean) => void;
  autoClaimRepos: () => string[];
  caps: () => { maxAttempts: number; maxCostUsd: number | null };
  getConfig: () => { config: Record<string, unknown>; overridden: string[] };
  setConfig: (key: string, value: string) => { ok: true } | { ok: false; error: string };
  prStatus: (repo: string, prNumber: number) => Promise<PrStatus | null>;
  submitReview: (
    repo: string,
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export async function handleApi(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: unknown,
  deps: RouterDeps,
): Promise<ApiResult | null> {
  if (path === '/api/dashboard' && method === 'GET') {
    const payload = await deps.dashboard(query.get('repo'));
    return { status: 200, json: payload };
  }
  if (path === '/api/agents' && method === 'GET') {
    return { status: 200, json: { runs: deps.db.listRuns(50).map(toRunSummary), autoClaim: deps.autoClaimRepos(), caps: deps.caps() } };
  }
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { ticketId?: string; title?: string; repo?: string; task?: string; mode?: string } | null;
    if (!b?.repo) return { status: 400, json: { error: 'repo required' } };
    const gate = deps.canStart(b.repo);
    if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
    if (b.mode === 'freeform') {
      if (!b.task) return { status: 400, json: { error: 'task required' } };
      const runId = deps.launch({ repo: b.repo, task: b.task });
      return { status: 200, json: { runId } };
    }
    if (!b.ticketId) return { status: 400, json: { error: 'ticketId and repo required' } };
    const runId = deps.launch({ ticketId: b.ticketId, title: b.title, repo: b.repo });
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
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
