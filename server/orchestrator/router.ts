import type { Db } from './db';

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface RouterDeps {
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  db: Db;
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
    return { status: 200, json: { runs: deps.db.listRuns(50) } };
  }
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
