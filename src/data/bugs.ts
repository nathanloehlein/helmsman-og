import type { BugsResponse } from '../types';

export async function fetchBugs(repo: string | null): Promise<BugsResponse> {
  const empty: BugsResponse = { cards: [], degraded: true, generatedAt: '', latestWindow: '', previousWindow: '' };
  try {
    const url: string = repo ? `/api/bugs?repo=${encodeURIComponent(repo)}` : '/api/bugs';
    const res: Response = await fetch(url);
    if (!res.ok) return empty;
    return (await res.json()) as BugsResponse;
  } catch {
    return empty;
  }
}
