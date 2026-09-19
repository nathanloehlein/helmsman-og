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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchRepoOpenPrs', () => {
  it('lists all authors, preserves drafts, and leaves unavailable statistics omitted', async () => {
    const fetchMock = vi.fn(async (url: URL) => url.pathname === '/repos/org/app/pulls'
      ? response([pull(1), pull(2, { draft: true, user: null })])
      : response({ message: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result).toEqual({ prs: [
      { number: 1, title: 'PR 1', createdAt: '2026-09-16T12:00:00Z', draft: false, repo: 'org/app', reviewDecision: '' },
      { number: 2, title: 'PR 2', createdAt: '2026-09-16T12:00:00Z', draft: true, repo: 'org/app', reviewDecision: '' },
    ], degraded: false, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const url: URL = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe('/repos/org/app/pulls');
    expect(url.searchParams.get('state')).toBe('open');
  });

  it('combines discussion and inline comments and tallies distinct effective reviewers across pages', async () => {
    const reviewed = (id: number, state: string, login: string) => ({ id, state, user: { login } });
    const calls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      calls.push(url);
      if (url.pathname.endsWith('/pulls')) return response([pull(1)]);
      if (url.pathname.endsWith('/pulls/1')) return response({
        comments: 4, review_comments: 6,
        requested_reviewers: [{ login: 'pending' }, { login: 'PENDING' }, { login: 'another' }],
        requested_teams: [{ slug: 'editors' }, { slug: 'EDITORS' }],
      });
      if (url.searchParams.get('page') === '2') return response([
        reviewed(6, 'COMMENTED', 'ALICE'), reviewed(7, 'APPROVED', 'bob'),
        reviewed(8, 'COMMENTED', 'carol'), reviewed(9, 'DISMISSED', 'dave'),
        reviewed(10, 'PENDING', 'frank'), { id: 11, state: 'APPROVED', user: null },
      ]);
      return response([
        reviewed(1, 'APPROVED', 'alice'), reviewed(2, 'CHANGES_REQUESTED', 'bob'),
        reviewed(3, 'COMMENTED', 'carol'), reviewed(4, 'APPROVED', 'dave'), reviewed(5, 'CHANGES_REQUESTED', 'eve'),
      ], 200, { link: '<https://api.github.com/repos/org/app/pulls/1/reviews?per_page=100&page=2>; rel="next"' });
    }));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result).toMatchObject({ degraded: false, truncated: false, prs: [{
      comments: 10, reviews: { approved: 2, changesRequested: 1, commented: 1, requested: 3 },
    }] });
    expect(calls).toHaveLength(4);
    expect(calls.some(url => url.pathname.includes('check'))).toBe(false);
  });

  it.each([
    {}, { comments: 2 }, { comments: -1, review_comments: 2 },
    { comments: 2, review_comments: '4' }, { comments: Number.MAX_SAFE_INTEGER, review_comments: 1 },
  ])('omits unknown or invalid comment totals without inventing zero: %j', detail => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.endsWith('/pulls') ? response([pull(1)])
      : url.pathname.endsWith('/reviews') ? response([]) : response({ ...detail, requested_reviewers: [], requested_teams: [] })));
    return fetchRepoOpenPrs(github, 'org/app').then(result => {
      expect(result.prs[0]).not.toHaveProperty('comments');
      expect(result.prs[0]?.reviews).toEqual({ approved: 0, changesRequested: 0, commented: 0, requested: 0 });
      expect(result.degraded).toBe(false);
    });
  });

  it.each([
    {}, { requested_reviewers: [] }, { requested_reviewers: null, requested_teams: [] },
    { requested_reviewers: [null], requested_teams: [] }, { requested_reviewers: [], requested_teams: [{}] },
  ])('omits incomplete request tallies while retaining available comment counts: %j', requests => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.endsWith('/pulls') ? response([pull(1)])
      : url.pathname.endsWith('/reviews') ? response([]) : response({ comments: 0, review_comments: 0, ...requests })));
    return fetchRepoOpenPrs(github, 'org/app').then(result => {
      expect(result.prs[0]?.comments).toBe(0);
      expect(result.prs[0]).not.toHaveProperty('reviews');
      expect(result.degraded).toBe(false);
    });
  });

  it.each(['reviews-fail', 'reviews-malformed', 'review-page-fails', 'detail-fails'])('keeps lists usable when optional statistics fail: %s', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/pulls')) return response([pull(1)]);
      if (url.pathname.endsWith('/pulls/1')) return failure === 'detail-fails'
        ? response({}, 503) : response({ comments: 2, review_comments: 3, requested_reviewers: [], requested_teams: [] });
      if (failure === 'reviews-fail' || url.searchParams.get('page') === '2') return response({}, 503);
      if (failure === 'reviews-malformed') return response([{ number: 1 }]);
      return response([{ state: 'APPROVED', user: { login: 'alice' } }], 200,
        failure === 'review-page-fails' ? { link: '<https://api.github.com/repos/org/app/pulls/1/reviews?per_page=100&page=2>; rel="next"' } : {});
    }));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]).not.toHaveProperty('reviews');
    if (failure === 'detail-fails') expect(result.prs[0]).not.toHaveProperty('comments');
    else expect(result.prs[0]?.comments).toBe(5);
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('bounds enrichment to the newest thirty PRs and at most eight concurrent GitHub reads', async () => {
    let active = 0;
    let peak = 0;
    const statsCalls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/pulls')) return response(Array.from({ length: 35 }, (_, index) => pull(index + 1, {
        created_at: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
      })));
      statsCalls.push(url);
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return response(url.pathname.endsWith('/reviews') ? [] : { comments: 0, review_comments: 0, requested_reviewers: [], requested_teams: [] });
    }));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs).toHaveLength(35);
    expect(result.prs.slice(0, 30).every(pr => pr.comments === 0 && pr.reviews?.approved === 0)).toBe(true);
    expect(result.prs.slice(30).every(pr => !('comments' in pr) && !('reviews' in pr))).toBe(true);
    expect(statsCalls).toHaveLength(60);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(result.truncated).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it.each([false, true])('returns by the enrichment deadline and ignores late statistics (completed row=%s)', async completeFirst => {
    vi.useFakeTimers();
    const late: { url: URL; resolve: (value: Response) => void }[] = [];
    const detail = { comments: 2, review_comments: 3, requested_reviewers: [], requested_teams: [] };
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/pulls')) return response(Array.from({ length: 10 }, (_, index) => pull(index + 1)));
      if (completeFirst && /\/pulls\/1(?:\/reviews)?$/.test(url.pathname)) {
        return response(url.pathname.endsWith('/reviews') ? [] : detail);
      }
      return new Promise<Response>(resolve => late.push({ url, resolve }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const finished = vi.fn();
    const pending = fetchRepoOpenPrs(github, 'org/app').then(result => { finished(); return result; });
    await vi.advanceTimersByTimeAsync(0);
    const expectedReads = completeFirst ? 11 : 9;
    expect(fetchMock).toHaveBeenCalledTimes(expectedReads);
    expect(late).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.prs).toHaveLength(10);
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (completeFirst) expect(result.prs[0]).toMatchObject({ comments: 5, reviews: { approved: 0, commented: 0, changesRequested: 0, requested: 0 } });
    const incomplete = result.prs.slice(completeFirst ? 1 : 0);
    expect(incomplete.every(pr => !('comments' in pr) && !('reviews' in pr))).toBe(true);
    const returned = JSON.stringify(result);
    for (const { url, resolve } of late) {
      resolve(url.pathname.endsWith('/reviews')
        ? response([{ state: 'APPROVED', user: { login: 'alice' } }], 200, { link: `<${url.origin}${url.pathname}?per_page=100&page=2>; rel="next"` })
        : response(detail));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(expectedReads);
    expect(JSON.stringify(result)).toBe(returned);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the enrichment deadline when all statistics finish quickly', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => response(url.pathname.endsWith('/pulls') ? [pull(1)]
      : url.pathname.endsWith('/reviews') ? [] : { comments: 0, review_comments: 0, requested_reviewers: [], requested_teams: [] })));
    const result = await fetchRepoOpenPrs(github, 'org/app');
    expect(result.prs[0]).toMatchObject({ comments: 0, reviews: { approved: 0, commented: 0, changesRequested: 0, requested: 0 } });
    expect(vi.getTimerCount()).toBe(0);
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
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname === '/search/issues') return response({ items: [], total_count: 0 });
      if (url.pathname.endsWith('/reviews')) return response([]);
      if (url.pathname.endsWith('/pulls/1')) return response({ comments: 0, review_comments: 0, requested_reviewers: [{ login: github.author }], requested_teams: [] });
      return response([pull(1, { requested_reviewers: [{ login: github.author }] })]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const [open, requested] = await Promise.all([
      fetchRepoOpenPrs(github, 'org/app'),
      fetchReviewRequestedPrs(github, ['org/app']),
    ]);
    expect(open.prs.map(pr => pr.number)).toEqual([1]);
    expect(requested.prs.map(pr => pr.number)).toEqual([1]);
    await fetchRepoOpenPrs(github, 'org/app');
    await fetchReviewRequestedPrs(github, ['org/app']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(open.prs[0]).toMatchObject({ comments: 0, reviews: { approved: 0, changesRequested: 0, commented: 0, requested: 1 } });
  });
});
