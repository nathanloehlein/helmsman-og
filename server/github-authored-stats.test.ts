import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenAuthoredPrs } from './github';
import { openPrToView } from './snapshot';

const github = { token: 'authored-stats', repo: 'octo/repo', author: 'octocat' };
const item = (number = 1) => ({
  number, title: `PR ${number}`, created_at: '2026-09-22T00:00:00Z',
  repository_url: 'https://api.github.com/repos/octo/repo', user: { login: github.author },
});
const detail = { comments: 3, review_comments: 4, requested_reviewers: [], requested_teams: [] };
const response = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('authored PR statistics', () => {
  it('counts discussion and inline comments and effective reviews across pages, deduplicating reads', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return response({ items: [item()] });
      if (url.pathname.endsWith('/pulls')) return response([item()]);
      if (url.pathname.endsWith('/reviews')) {
        if (url.searchParams.get('page') === '2') return response([
          { id: 3, state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
          { id: 4, state: 'COMMENTED', user: { login: 'ALICE' } },
        ]);
        return response([
          { id: 1, state: 'APPROVED', user: { login: 'alice' } },
          { id: 2, state: 'APPROVED', user: { login: 'bob' } },
        ], 200, { link: '<https://api.github.com/repos/octo/repo/pulls/1/reviews?per_page=100&page=2>; rel="next"' });
      }
      return response(detail);
    });
    vi.stubGlobal('fetch', fetcher);
    const prs = await fetchOpenAuthoredPrs(github, [github.repo]);
    expect(prs).toHaveLength(1);
    expect(openPrToView(prs[0]!)).toMatchObject({
      comments: 7, reviews: { approved: 1, changesRequested: 1, commented: 0, requested: 0 },
      reviewDecision: 'CHANGES_REQUESTED',
    });
    await fetchOpenAuthoredPrs(github, [github.repo]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.filter(([input]) => new URL(input).pathname.endsWith('/reviews'))).toHaveLength(2);
  });

  it.each(['reviews', 'detail', 'malformed'])('keeps unavailable counts unknown when %s fails', async failure => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return response({ items: [item()] });
      if (url.pathname.endsWith('/reviews')) return failure === 'reviews' ? response({}, 503)
        : response([{ state: 'APPROVED', user: { login: 'alice' } }]);
      return failure === 'detail' ? response({}, 503) : response(failure === 'malformed' ? { comments: -1 } : detail);
    });
    vi.stubGlobal('fetch', fetcher);
    const pr = (await fetchOpenAuthoredPrs(github))[0]!;
    expect(pr).not.toHaveProperty('reviews');
    if (failure === 'reviews') {
      expect(pr.comments).toBe(7);
      expect(pr.reviewDecision).toBeNull();
    } else {
      expect(pr).not.toHaveProperty('comments');
      expect(pr.reviewDecision).toBe('REVIEW_REQUIRED');
    }
    expect(fetcher.mock.calls.filter(([input]) => new URL(input).pathname.endsWith('/reviews'))).toHaveLength(1);
  });

  it('preserves confirmed zero counts through the snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      return response(url.pathname === '/search/issues' ? { items: [item()] }
        : url.pathname.endsWith('/reviews') ? [] : { ...detail, comments: 0, review_comments: 0 });
    }));
    expect(openPrToView((await fetchOpenAuthoredPrs(github))[0]!)).toMatchObject({
      comments: 0, reviews: { approved: 0, changesRequested: 0, commented: 0, requested: 0 },
    });
  });

  it('bounds enrichment to thirty PRs with four workers', async () => {
    let inflight = 0;
    let maximum = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return response({ items: Array.from({ length: 35 }, (_, index) => item(index + 1)) });
      inflight++;
      maximum = Math.max(maximum, inflight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inflight--;
      return response(url.pathname.endsWith('/reviews') ? [] : detail);
    });
    vi.stubGlobal('fetch', fetcher);
    const prs = await fetchOpenAuthoredPrs(github);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(fetcher).toHaveBeenCalledTimes(61);
    expect(prs.slice(0, 30).every(pr => pr.comments === 7)).toBe(true);
    expect(prs.slice(30).every(pr => pr.comments === undefined && pr.reviews === undefined)).toBe(true);
  });

  it('returns after the stats deadline and does not mutate returned rows later', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return response({ items: Array.from({ length: 6 }, (_, index) => item(index + 1)) });
      await blocked;
      return response(url.pathname.endsWith('/reviews') ? [] : detail);
    });
    vi.stubGlobal('fetch', fetcher);
    const result = fetchOpenAuthoredPrs(github);
    await vi.advanceTimersByTimeAsync(8_000);
    const prs = await result;
    expect(prs).toHaveLength(6);
    expect(prs.every(pr => pr.comments === undefined && pr.reviews === undefined)).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(prs.every(pr => pr.comments === undefined && pr.reviews === undefined)).toBe(true);
  });
});
