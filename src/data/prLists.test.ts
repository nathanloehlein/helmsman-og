import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoOpenPrs, fetchReviewRequests } from './prLists';

const realFetch = globalThis.fetch;
const pr = { number: 42, title: 'A change', repo: 'org/repo', reviewDecision: '', draft: false, createdAt: '2026-09-16T12:00:00Z' };

afterEach(() => { globalThis.fetch = realFetch; });

function respond(payload: unknown): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
}

describe('PR lists transport', () => {
  it('supports All galleons and encodes selected galleon requests', async () => {
    respond({ prs: [pr], degraded: false, truncated: true });
    expect(await fetchReviewRequests()).toEqual({ prs: [pr], degraded: false, truncated: true });
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/pr/review-requests');
    await fetchReviewRequests('org/repo');
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/pr/review-requests?repo=org%2Frepo');
    await fetchRepoOpenPrs('org/repo');
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/pr/open?repo=org%2Frepo');
  });

  it('keeps valid partial results but flags malformed rows', async () => {
    respond({ prs: [null, { ...pr, number: -1 }, { ...pr, repo: '../bad' }, { ...pr, createdAt: 'invalid' }, pr], degraded: false, truncated: false });
    expect(await fetchReviewRequests()).toEqual({ prs: [pr], degraded: true, truncated: false });
  });

  it.each([null, {}, { prs: null }, { prs: [], degraded: false }])('marks malformed responses unavailable: %j', async (payload) => {
    respond(payload);
    expect(await fetchReviewRequests()).toEqual({ prs: [], degraded: true, truncated: false });
  });

  it('marks a failed request unavailable instead of healthy-empty', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));
    expect((await fetchReviewRequests()).degraded).toBe(true);
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    expect((await fetchRepoOpenPrs('org/repo')).degraded).toBe(true);
  });
});
