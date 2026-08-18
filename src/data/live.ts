import type { DashboardSnapshot } from './mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
  repos: string[];
  selectedRepo: string | null;
}

export const POLL_MS: number = 30_000;

export async function loadDashboard(repo: string | null = null): Promise<DashboardResponse> {
  const query: string = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  const res: Response = await fetch(`/api/dashboard${query}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`dashboard endpoint ${res.status}`);
  return res.json() as Promise<DashboardResponse>;
}
