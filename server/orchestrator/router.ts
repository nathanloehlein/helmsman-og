import type { Db } from './db';

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface RouterDeps {
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  db: Db;
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: { ticketId: string; title: string; repo: string }) => string;
  stop: (runId: string) => boolean;
  setAutoClaim: (repo: string, enabled: boolean) => void;
  autoClaimRepos: () => string[];
  caps: () => { maxAttempts: number; maxCostUsd: number | null };
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
    return { status: 200, json: { runs: deps.db.listRuns(50), autoClaim: deps.autoClaimRepos(), caps: deps.caps() } };
  }
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { ticketId?: string; title?: string; repo?: string } | null;
    if (!b?.ticketId || !b.repo) return { status: 400, json: { error: 'ticketId and repo required' } };
    const gate = deps.canStart(b.repo);
    if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
    const runId = deps.launch({ ticketId: b.ticketId, title: b.title ?? b.ticketId, repo: b.repo });
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
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
