import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoOpenPrs, fetchReviewRequestedPrs } from './pr-lists';
import type { GithubConfig } from './config';

const github: GithubConfig = { token: 'token', author: 'captain', repo: 'org/app' };
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, created_at: '2026-09-16T12:00:00Z', draft: false,
  user: { login: 'someone-else' }, requested_reviewers: [], ...extra,
});
const searchItem = (number: number, extra: Record<string, unknown> = {}) =>
  pull(number, { repository_url: 'https://api.github.com/repos/org/app', ...extra });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe('fetchRepoOpenPrs', () => {
  it('lists all authors, preserves drafts, and does not invent review decisions or fetch reviews', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([pull(1), pull(2, { draft: true, user: null })]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result).toEqual({ prs: [
      { number: 1, title: 'PR 1', createdAt: '2026-09-16T12:00:00Z', draft: false, repo: 'org/app', reviewDecision: '' },
      { number: 2, title: 'PR 2', createdAt: '2026-09-16T12:00:00Z', draft: true, repo: 'org/app', reviewDecision: '' },
    ], degraded: false, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url: URL = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe('/repos/org/app/pulls');
    expect(url.searchParams.get('state')).toBe('open');
  });

  it('bounds pagination and signals truncation when more repository PRs exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const page: number = Number(url.searchParams.get('page'));
      return response(Array.from({ length: 100 }, (_, i) => pull((page - 1) * 100 + i + 1)), 200, { link: '<https://api.github.com/next>; rel="next"' });
    }));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs).toHaveLength(300);
    expect(result.truncated).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('keeps earlier pages when a later page fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([pull(1)], 200, { link: '<https://api.github.com/next>; rel="next"' }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs.map((pr) => pr.number)).toEqual([1]);
    expect(result.degraded).toBe(true);
  });

  it('drops malformed rows and reports degraded data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([null, {}, pull(2, { created_at: null }), pull(3), pull(4, { number: -1 })])));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs.map((pr) => pr.number)).toEqual([3]);
    expect(result.degraded).toBe(true);
  });

  it.each([null, {}, 'bad response'])('marks malformed API envelopes as degraded: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    expect(await fetchRepoOpenPrs(github, 'org/app')).toEqual({ prs: [], degraded: true, truncated: false });
  });

  it('does not fetch without configuration or with an invalid repository', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchRepoOpenPrs(null, 'org/app')).degraded).toBe(true);
    expect((await fetchRepoOpenPrs(github, 'org/../app')).degraded).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchReviewRequestedPrs', () => {
  it('searches requests to the configured user including team requests and merges direct repository requests', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (url.pathname === '/search/issues') {
        queries.push(url.searchParams.get('q') ?? '');
        return response({ items: [searchItem(1)], total_count: 1, incomplete_results: false });
      }
      return response([
        pull(1, { requested_reviewers: [{ login: 'captain' }] }),
        pull(2, { requested_reviewers: [null, { login: 'CAPTAIN' }] }),
        pull(3, { requested_reviewers: [{ login: 'other' }] }),
      ]);
    }));
    const result = await fetchReviewRequestedPrs(github, ['org/app', 'org/app']);
    expect(queries).toEqual(['is:pr is:open review-requested:captain']);
    expect(result.prs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(result.prs.every((pr) => pr.reviewDecision === 'REVIEW_REQUIRED')).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('restricts both sources to the selected repository', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      urls.push(url.toString());
      return response(url.pathname === '/search/issues' ? { items: [], total_count: 0 } : []);
    }));
    await fetchReviewRequestedPrs(github, ['org/app', 'org/other'], 'org/selected');
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0] ?? '').searchParams.get('q')).toBe('is:pr is:open review-requested:captain repo:org/selected');
    expect(new URL(urls[1] ?? '').pathname).toBe('/repos/org/selected/pulls');
  });

  it('returns fallback requests while exposing search failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/search/issues'
      ? response({ message: 'forbidden' }, 403)
      : response([pull(4, { requested_reviewers: [{ login: 'captain' }] })])));
    const result = await fetchReviewRequestedPrs(github, ['org/app']);
    expect(result.prs.map((pr) => pr.number)).toEqual([4]);
    expect(result.degraded).toBe(true);
  });

  it('preserves search requests when a configured repository fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/search/issues'
      ? response({ items: [searchItem(1)], total_count: 1 })
      : response({ message: 'not found' }, 404)));
    const result = await fetchReviewRequestedPrs(github, ['org/app']);
    expect(result.prs).toHaveLength(1);
    expect(result.degraded).toBe(true);
  });

  it('guards malformed search rows, repo URLs and reviewer fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/search/issues'
      ? response({ items: [null, searchItem(1, { repository_url: 'https://evil.example/repos/org/app' }), searchItem(2)], incomplete_results: true })
      : response([null, pull(3, { requested_reviewers: null })])));
    const result = await fetchReviewRequestedPrs(github, ['org/app']);
    expect(result.prs.map((pr) => pr.number)).toEqual([2]);
    expect(result.degraded).toBe(true);
  });

  it('marks search pagination truncation from total_count', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const page: number = Number(url.searchParams.get('page'));
      return response({ items: [searchItem(page)], total_count: 350 });
    }));
    const result = await fetchReviewRequestedPrs(github);
    expect(result.prs).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('returns a degraded empty list without GitHub configuration', async () => {
    expect(await fetchReviewRequestedPrs(null)).toEqual({ prs: [], degraded: true, truncated: false });
  });
});

describe('shared GitHub list polling', () => {
  it('reuses the same repository scan across open PRs and review requests', async () => {
    const fetchMock = vi.fn(async (url: URL) => url.pathname === '/search/issues'
      ? response({ items: [], total_count: 0 })
      : response([pull(1, { requested_reviewers: [{ login: github.author }] })]));
    vi.stubGlobal('fetch', fetchMock);
    const [open, requested] = await Promise.all([
      fetchRepoOpenPrs(github, 'org/app'),
      fetchReviewRequestedPrs(github, ['org/app']),
    ]);
    expect(open.prs.map(pr => pr.number)).toEqual([1]);
    expect(requested.prs.map(pr => pr.number)).toEqual([1]);
    await fetchRepoOpenPrs(github, 'org/app');
    await fetchReviewRequestedPrs(github, ['org/app']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
