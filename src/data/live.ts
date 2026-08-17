import type { DashboardSnapshot } from './mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
}

export const POLL_MS: number = 30_000;

export async function loadDashboard(): Promise<DashboardResponse> {
  const res: Response = await fetch('/api/dashboard', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`dashboard endpoint ${res.status}`);
  return res.json() as Promise<DashboardResponse>;
}
