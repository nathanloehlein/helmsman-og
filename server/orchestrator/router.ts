import type { Db, RunRow } from './db';
import type { PrStatus } from '../github';
import type { TriageResponse } from '../triage-endpoint';
import type { BugsResponse } from '../../src/types';
import type { CmuxTab } from './cmux/model';
import { isAllowedKey } from './cmux/keys';

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
  triage: (repo: string | null) => Promise<TriageResponse>;
  bugs: (repo: string | null) => Promise<BugsResponse>;
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: { ticketId?: string; title?: string; repo: string; task?: string; prNumber?: number; mode?: string; feedback?: string; model?: string; effort?: string }) => string;
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
    return { status: 200, json: { runs: deps.db.listRuns(50).map(toRunSummary), autoClaim: deps.autoClaimRepos(), caps: deps.caps() } };
  }
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { ticketId?: string; title?: string; repo?: string; task?: string; mode?: string; prNumber?: number; feedback?: string; model?: string; effort?: string } | null;
    if (!b?.repo) return { status: 400, json: { error: 'repo required' } };
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
