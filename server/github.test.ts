import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthoredPrs, fetchOpenAuthoredPrs, fetchPrDiff, fetchPrStatus, requestCopilotReview, submitReview } from './github';
import type { GithubConfig } from './config';
import type { PrStatus } from './github';

const github: GithubConfig = {
  token: 'tok',
  repo: 'octo/repo',
  author: 'octocat',
};

function jsonResponse(ok: boolean, body: unknown, responseHeaders: HeadersInit = {}): Response {
  return {
    ok,
    status: ok ? 200 : 422,
    headers: new Headers(responseHeaders),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('fetchPrStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps pulls, check-runs, and reviews into a PrStatus', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.endsWith('/pulls/5')) {
        return jsonResponse(true, {
          state: 'open',
          draft: false,
          merged: false,
          updated_at: '2026-09-17T12:00:00Z',
          head: { ref: 'fix/x', sha: 'abc' },
          comments: 2,
          html_url: 'u',
        });
      }
      if (href.endsWith('/commits/abc/check-runs')) {
        return jsonResponse(true, {
          check_runs: [
            { status: 'completed', conclusion: 'success' },
            { status: 'in_progress', conclusion: null },
            { status: 'completed', conclusion: 'failure' },
          ],
        });
      }
      if (href.includes('/pulls/5/reviews')) {
        return jsonResponse(true, []);
      }
      throw new Error(`unexpected url: ${href}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const status: PrStatus | null = await fetchPrStatus(github, 'octo/repo', 5);

    expect(status).toEqual({
      number: 5,
      repo: 'octo/repo',
      authorLogin: null,
      isOwnPr: false,
      viewerReview: null,
      updatedAt: '2026-09-17T12:00:00Z',
      state: 'open',
      draft: false,
      merged: false,
      headRefName: 'fix/x',
      headSha: 'abc',
      reviewDecision: 'REVIEW_REQUIRED',
      comments: 2,
      checks: { passed: 1, failed: 1, pending: 1 },
      reviews: { requested: 0, approved: 0, changesRequested: 0, commented: 0 },
      reviewsAvailable: true,
      url: 'u',
    });
  });

  it('tallies reviewers by latest state per user plus pending requests', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.endsWith('/pulls/5')) {
        return jsonResponse(true, {
          state: 'open',
          draft: false,
          merged: false,
          head: { ref: 'fix/x', sha: 'abc' },
          comments: 2,
          html_url: 'u',
          requested_reviewers: [{ login: 'pending-a' }, { login: 'pending-b' }],
          requested_teams: [{ slug: 'team-x' }],
        });
      }
      if (href.endsWith('/commits/abc/check-runs')) {
        return jsonResponse(true, { check_runs: [] });
      }
      if (href.includes('/pulls/5/reviews')) {
        return jsonResponse(true, [
          { state: 'COMMENTED', user: { login: 'alice' } },
          { state: 'APPROVED', user: { login: 'alice' } },
          { state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
          { state: 'COMMENTED', user: { login: 'carol' } },
          { state: 'DISMISSED', user: { login: 'dave' } },
        ]);
      }
      throw new Error(`unexpected url: ${href}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const status: PrStatus | null = await fetchPrStatus(github, 'octo/repo', 5);

    expect(status?.reviews).toEqual({ requested: 3, approved: 1, changesRequested: 1, commented: 1 });
    expect(status?.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  async function statusWithReviews(reviews: unknown, user: unknown = { login: 'OcToCaT' }, reviewOk = true, updatedAt?: unknown): Promise<PrStatus | null> {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith('/pulls/5')) return jsonResponse(true, {
        title: 'Fix image selection', user, state: 'open', head: { ref: 'fix/x', sha: 'abc' }, html_url: 'u',
        updated_at: updatedAt,
      });
      if (href.includes('/reviews')) return jsonResponse(reviewOk, reviews);
      if (href.endsWith('/check-runs')) return jsonResponse(true, { check_runs: [] });
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const status = await fetchPrStatus(github, 'octo/repo', 5);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    return status;
  }

  it.each([
    [[], 0, 'REVIEW_REQUIRED'],
    [['alice'], 1, 'REVIEW_REQUIRED'],
    [['alice', 'bob'], 2, 'APPROVED'],
    [['alice', 'bob', 'carol'], 3, 'APPROVED'],
    [['alice', 'alice'], 1, 'REVIEW_REQUIRED'],
    [['alice', 'ALICE', ' Alice '], 1, 'REVIEW_REQUIRED'],
  ])('requires two distinct approvers for %j', async (logins, approved, decision) => {
    const status = await statusWithReviews(logins.map((login) => ({ state: 'APPROVED', user: { login } })));
    expect(status).toMatchObject({ reviews: { approved }, reviewDecision: decision, reviewsAvailable: true });
  });

  it('keeps another reviewer’s change request blocking after two approvals', async () => {
    const status = await statusWithReviews([
      { state: 'CHANGES_REQUESTED', user: { login: 'alice' } },
      { state: 'APPROVED', user: { login: 'bob' } },
      { state: 'APPROVED', user: { login: 'carol' } },
    ]);
    expect(status).toMatchObject({ reviews: { approved: 2, changesRequested: 1 }, reviewDecision: 'CHANGES_REQUESTED' });
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED'])('removes a dismissed %s from the aggregate', async (state) => {
    const status = await statusWithReviews([
      { id: 3, state: 'DISMISSED', user: { login: 'ALICE' } },
      { id: 1, state, user: { login: 'alice' } },
      { id: 2, state: 'APPROVED', user: { login: 'bob' } },
    ]);
    expect(status).toMatchObject({ reviews: { approved: 1, changesRequested: 0 }, reviewDecision: 'REVIEW_REQUIRED' });
  });

  it('ignores reviews without valid authors and unsubmitted approvals', async () => {
    const status = await statusWithReviews([
      { state: 'APPROVED', user: null },
      { state: 'APPROVED', user: {} },
      { state: 'APPROVED', user: { login: 42 } },
      { state: 'APPROVED', user: { login: ' ' } },
      { state: 'APPROVED', submitted_at: null, user: { login: 'alice' } },
    ]);
    expect(status).toMatchObject({ reviews: { approved: 0 }, reviewDecision: 'REVIEW_REQUIRED', reviewsAvailable: true });
  });

  it.each([
    [{ login: 'OcToCaT' }, 'OcToCaT', true],
    [{ login: 'another-user' }, 'another-user', false],
    [null, null, false],
    [{}, null, false],
    [{ login: 42 }, null, false],
    [{ login: '' }, null, false],
  ])('identifies ownership from the configured user for %j', async (user, authorLogin, isOwnPr) => {
    expect(await statusWithReviews([], user)).toMatchObject({ title: 'Fix image selection', authorLogin, isOwnPr, viewerReview: null });
  });

  it('uses the newest submitted personal decision despite review response order and other reviewers', async () => {
    const status = await statusWithReviews([
      { id: 3, submitted_at: '2026-09-17T12:00:00Z', state: 'APPROVED', user: { login: 'OCTOCAT' } },
      { id: 4, submitted_at: '2026-09-17T11:00:00Z', state: 'CHANGES_REQUESTED', user: { login: 'octocat' } },
      { id: 5, submitted_at: '2026-09-17T13:00:00Z', state: 'CHANGES_REQUESTED', user: { login: 'someone-else' } },
      { id: 6, submitted_at: null, state: 'PENDING', user: { login: 'octocat' } },
      { state: 'APPROVED', user: null },
      null,
      { state: 'INVALID', user: { login: 'octocat' } },
    ]);
    expect(status?.viewerReview).toBe('APPROVED');
    expect(status?.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])('retains %s when a subsequent review only comments', async (state) => {
    const status = await statusWithReviews([
      { id: 10, state, user: { login: 'octocat' } },
      { id: 11, state: 'COMMENTED', user: { login: 'octocat' } },
    ]);
    expect(status?.viewerReview).toBe(state);
    expect(status?.reviews).toMatchObject({
      approved: state === 'APPROVED' ? 1 : 0,
      changesRequested: state === 'CHANGES_REQUESTED' ? 1 : 0,
      commented: 0,
    });
  });

  it('returns the latest personal review time and commit independently of the effective decision', async () => {
    const status = await statusWithReviews([
      { id: 12, submitted_at: '2026-09-17T12:00:00Z', commit_id: 'new-head', state: 'COMMENTED', user: { login: ' OcToCaT ' } },
      { id: 13, submitted_at: '2026-09-17T13:00:00Z', commit_id: 'other-head', state: 'APPROVED', user: { login: 'someone-else' } },
      { id: 10, submitted_at: '2026-09-17T10:00:00Z', commit_id: 'old-head', state: 'APPROVED', user: { login: 'octocat' } },
    ]);
    expect(status).toMatchObject({
      viewerReview: 'APPROVED',
      viewerReviewedAt: '2026-09-17T12:00:00Z',
      viewerReviewedCommitId: 'new-head',
      headSha: 'abc',
    });
  });

  it('ignores malformed and unsubmitted personal review timestamps', async () => {
    const status = await statusWithReviews([
      { state: 'APPROVED', submitted_at: '2026-09-17T10:00:00Z', commit_id: 'reviewed-head', user: { login: 'octocat' } },
      ...[null, undefined, '', 'invalid', 42].map(submitted_at => ({
        state: 'APPROVED', submitted_at, commit_id: 'ignored-head', user: { login: 'octocat' },
      })),
      { state: 'PENDING', submitted_at: '2026-09-17T15:00:00Z', commit_id: 'pending-head', user: { login: 'octocat' } },
      { state: 'INVALID', submitted_at: '2026-09-17T15:00:00Z', user: { login: 'octocat' } },
    ]);
    expect(status).toMatchObject({ viewerReviewedAt: '2026-09-17T10:00:00Z', viewerReviewedCommitId: 'reviewed-head' });
  });

  it.each([null, undefined, '', 'invalid', 42])('omits an invalid PR update timestamp: %j', async updatedAt => {
    const status = await statusWithReviews([], undefined, true, updatedAt);
    expect(status?.updatedAt).toBeUndefined();
    expect(status?.viewerReviewedAt).toBeUndefined();
    expect(status?.viewerReviewedCommitId).toBeUndefined();
  });

  it('does not reuse an earlier reviewed commit when the latest review has no commit', async () => {
    const status = await statusWithReviews([
      { state: 'APPROVED', submitted_at: '2026-09-17T10:00:00Z', commit_id: 'old-head', user: { login: 'octocat' } },
      { state: 'DISMISSED', submitted_at: '2026-09-17T11:00:00Z', commit_id: null, user: { login: 'octocat' } },
    ]);
    expect(status?.viewerReviewedAt).toBe('2026-09-17T11:00:00Z');
    expect(status?.viewerReviewedCommitId).toBeUndefined();
  });

  it('reports a dismissed review when it supersedes an earlier decision', async () => {
    const status = await statusWithReviews([
      { id: 12, state: 'DISMISSED', user: { login: 'octocat' } },
      { id: 11, state: 'APPROVED', user: { login: 'octocat' } },
    ]);
    expect(status?.viewerReview).toBe('DISMISSED');
  });

  it('falls back to response order without review timestamps or IDs', async () => {
    const status = await statusWithReviews([
      { state: 'APPROVED', user: { login: 'octocat' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'octocat' } },
    ]);
    expect(status?.viewerReview).toBe('CHANGES_REQUESTED');
  });

  it('reports commented when the viewer has only submitted comments', async () => {
    expect((await statusWithReviews([{ state: 'COMMENTED', user: { login: 'octocat' } }]))?.viewerReview).toBe('COMMENTED');
  });

  it.each([null, {}, [{ state: 'APPROVED', submitted_at: null, user: { login: 'octocat' } }]])('ignores unavailable or unsubmitted reviews: %j', async (reviews) => {
    expect((await statusWithReviews(reviews))?.viewerReview).toBeNull();
  });

  it('retains ownership when review lookup fails', async () => {
    expect(await statusWithReviews({ message: 'forbidden' }, { login: 'octocat' }, false)).toMatchObject({ isOwnPr: true, viewerReview: null, reviewsAvailable: false });
  });

  function stubReviewPages(pages: (url: URL) => Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/reviews')) return pages(url);
      if (url.pathname.endsWith('/pulls/5')) return jsonResponse(true, {
        user: { login: 'octocat' }, state: 'open', head: { ref: 'fix/x', sha: 'abc' }, html_url: 'u',
      });
      if (url.pathname.endsWith('/check-runs')) return jsonResponse(true, { check_runs: [] });
      throw new Error(`unexpected url: ${url.href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('finds a personal review on the next page without refetching PR metadata', async () => {
    const fetchMock = stubReviewPages((url) => url.searchParams.get('page') === '2'
      ? jsonResponse(true, [{ id: 102, state: 'APPROVED', user: { login: 'octocat' } }])
      : jsonResponse(true, [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'octocat' } }], {
        link: '<https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100&page=2>; rel="next", <https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100&page=2>; rel="last"',
      }));
    expect(await fetchPrStatus(github, 'octo/repo', 5)).toMatchObject({ viewerReview: 'APPROVED', reviewDecision: 'REVIEW_REQUIRED', isOwnPr: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    'not a valid link',
    '<https://example.com/repos/octo/repo/pulls/5/reviews?page=2>; rel="next"',
    '<https://api.github.com/repos/octo/repo/pulls/6/reviews?page=2>; rel="next"',
    '<http://api.github.com/repos/octo/repo/pulls/5/reviews?page=2>; rel="next"',
    '<https://user:password@api.github.com/repos/octo/repo/pulls/5/reviews?page=2>; rel="next"',
    '<https://api.github.com/repos/octo/repo/pulls/5/reviews?page=2#fragment>; rel="next"',
    '<https://api.github.com/repos/octo/repo/pulls/5/reviews?page=2>; rel="next", <https://api.github.com/repos/octo/repo/pulls/5/reviews?page=3>; rel="next"',
  ])('rejects malformed or unsafe next-page links without using partial reviews: %s', async (link) => {
    const fetchMock = stubReviewPages(() => jsonResponse(true, [{ state: 'APPROVED', user: { login: 'octocat' } }], { link }));
    expect(await fetchPrStatus(github, 'octo/repo', 5)).toMatchObject({ viewerReview: null, reviewDecision: 'REVIEW_REQUIRED', reviewsAvailable: false, isOwnPr: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['failed', 'invalid', 'throws'])('discards partial reviews when a later page %s', async (failure) => {
    stubReviewPages((url) => {
      if (url.searchParams.get('page') !== '2') return jsonResponse(true, [{ state: 'APPROVED', user: { login: 'octocat' } }], {
        link: '<https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100&page=2>; rel="next"',
      });
      if (failure === 'throws') throw new Error('unavailable');
      return jsonResponse(failure !== 'failed', { message: 'unavailable' });
    });
    expect((await fetchPrStatus(github, 'octo/repo', 5))?.viewerReview).toBeNull();
  });

  it('stops review pagination at ten pages without using incomplete state', async () => {
    const fetchMock = stubReviewPages((url) => jsonResponse(true, [{ state: 'APPROVED', user: { login: 'octocat' } }], {
      link: `<https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100&page=${Number(url.searchParams.get('page') ?? 1) + 1}>; rel="next"`,
    }));
    expect((await fetchPrStatus(github, 'octo/repo', 5))?.viewerReview).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('stops repeated next-page links without using partial reviews', async () => {
    const fetchMock = stubReviewPages(() => jsonResponse(true, [{ state: 'APPROVED', user: { login: 'octocat' } }], {
      link: '<https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100>; rel="next"',
    }));
    expect((await fetchPrStatus(github, 'octo/repo', 5))?.viewerReview).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null on a non-ok pulls fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(false, { message: 'not found' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const status: PrStatus | null = await fetchPrStatus(github, 'octo/repo', 5);

    expect(status).toBeNull();
  });

  it('degrades checks to zeros when the check-runs fetch is non-ok', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.endsWith('/pulls/5')) {
        return jsonResponse(true, {
          state: 'open',
          draft: false,
          merged: false,
          head: { ref: 'fix/x', sha: 'abc' },
          comments: 2,
          html_url: 'u',
        });
      }
      if (href.endsWith('/commits/abc/check-runs')) {
        return jsonResponse(false, { message: 'boom' });
      }
      if (href.includes('/pulls/5/reviews')) {
        return jsonResponse(true, []);
      }
      throw new Error(`unexpected url: ${href}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const status: PrStatus | null = await fetchPrStatus(github, 'octo/repo', 5);

    expect(status?.checks).toEqual({ passed: 0, failed: 0, pending: 0 });
  });
});

describe('submitReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the event and body and returns ok on success', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ event: 'APPROVE', body: 'looks good' });
      return jsonResponse(true, {});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitReview(github, 'octo/repo', 5, 'APPROVE', 'looks good');

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the GitHub message on a non-ok response', async () => {
    const fetchMock = vi.fn(
      async () => jsonResponse(false, { message: 'Can not approve your own pull request' }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitReview(github, 'octo/repo', 5, 'APPROVE', 'looks good');

    expect(result).toEqual({ ok: false, error: 'Can not approve your own pull request' });
  });

  it('returns ok:false when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitReview(github, 'octo/repo', 5, 'COMMENT', 'note');

    expect(result.ok).toBe(false);
  });
});

describe('fetchAuthoredPrs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges search results with a direct per-repo scan and de-dupes, newest first', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.includes('/search/issues')) {
        return jsonResponse(true, {
          items: [
            { number: 1, title: 'searched', repository_url: 'https://api.github.com/repos/gdcorp-im/x', created_at: '2026-08-01T00:00:00Z', user: { login: 'octocat' }, pull_request: { merged_at: null } },
          ],
        });
      }
      if (href.includes('/repos/gdcorp-partners/gated/pulls')) {
        return jsonResponse(true, [
          { number: 9, title: 'gated recent', created_at: '2026-09-01T00:00:00Z', merged_at: null, head: { ref: 'feat/x' }, user: { login: 'octocat' } },
          { number: 10, title: 'not mine', created_at: '2026-09-02T00:00:00Z', merged_at: null, user: { login: 'other' } },
        ]);
      }
      if (href.includes('/reviews')) return jsonResponse(true, []);
      throw new Error(`unexpected url: ${href}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const prs = await fetchAuthoredPrs(github, ['gdcorp-partners/gated']);

    expect(prs.map((p) => p.number)).toEqual([9, 1]);
    expect(prs.find((p) => p.number === 10)).toBeUndefined();
    expect(prs.find((p) => p.number === 9)?.headRef).toBe('feat/x');
  });
});

describe('fetchOpenAuthoredPrs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges author-search results with a direct per-repo pulls scan, keeping only the author and de-duping', async () => {
    const T: string = '2026-09-01T00:00:00Z';
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.includes('/search/issues')) {
        return jsonResponse(true, {
          items: [
            { number: 1, title: 'from search', repository_url: 'https://api.github.com/repos/gdcorp-im/x', created_at: T, draft: false, user: { login: 'octocat' } },
          ],
        });
      }
      if (href.includes('/repos/gdcorp-partners/gated/pulls')) {
        return jsonResponse(true, [
          { number: 5, title: 'mine in gated org', created_at: T, draft: false, user: { login: 'octocat' } },
          { number: 6, title: 'someone else', created_at: T, draft: true, user: { login: 'other' } },
        ]);
      }
      if (href.includes('/reviews')) return jsonResponse(true, []);
      throw new Error(`unexpected url: ${href}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const prs = await fetchOpenAuthoredPrs(github, ['gdcorp-partners/gated']);
    const numbers = prs.map((p) => p.number).sort();

    expect(numbers).toEqual([1, 5]);
    expect(prs.find((p) => p.number === 6)).toBeUndefined();
  });
});

describe('requestCopilotReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the Copilot bot to the requested_reviewers endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe('https://api.github.com/repos/octo/repo/pulls/5/requested_reviewers');
      expect(JSON.parse(init?.body as string)).toEqual({ reviewers: ['copilot-pull-request-reviewer[bot]'] });
      return jsonResponse(true, {});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestCopilotReview(github, 'octo/repo', 5);

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the GitHub message when Copilot review is unavailable', async () => {
    const fetchMock = vi.fn(
      async () => jsonResponse(false, { message: 'Reviews may only be requested from collaborators.' }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestCopilotReview(github, 'octo/repo', 5);

    expect(result).toEqual({ ok: false, error: 'Reviews may only be requested from collaborators.' });
  });

  it('returns ok:false when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestCopilotReview(github, 'octo/repo', 5);

    expect(result.ok).toBe(false);
  });
});

describe('fetchPrDiff', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps per-file patches and paginates until a short page', async () => {
    const page1: unknown[] = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: `@@ p${i} @@` }));
    const page2 = [{ filename: 'bin.png', status: 'added', additions: 0, deletions: 0 }];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href: string = url.toString();
      if (href.includes('/pulls/5/files')) {
        return jsonResponse(true, href.includes('page=2') ? page2 : page1);
      }
      return jsonResponse(false, {});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const diff = await fetchPrDiff(github, 'octo/repo', 5);
    expect(diff).not.toBeNull();
    expect(diff!.length).toBe(101);
    expect(diff![0]).toEqual({ filename: 'f0.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ p0 @@' });
    expect(diff![100]).toEqual({ filename: 'bin.png', status: 'added', additions: 0, deletions: 0, patch: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the first page is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(false, {})) as unknown as typeof fetch);
    expect(await fetchPrDiff(github, 'octo/repo', 5)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch);
    expect(await fetchPrDiff(github, 'octo/repo', 5)).toBeNull();
  });
});

describe('dashboard GitHub caching', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['empty', [], 'REVIEW_REQUIRED'],
    ['one approval', [{ state: 'APPROVED', user: { login: 'alice' } }], 'REVIEW_REQUIRED'],
    ['two approvals', [{ state: 'APPROVED', user: { login: 'alice' } }, { state: 'APPROVED', user: { login: 'bob' } }], 'APPROVED'],
    ['repeat approval', [{ state: 'APPROVED', user: { login: 'alice' } }, { state: 'APPROVED', user: { login: 'ALICE' } }], 'REVIEW_REQUIRED'],
    ['blocking review', [{ state: 'CHANGES_REQUESTED', user: { login: 'alice' } }, { state: 'APPROVED', user: { login: 'bob' } }], 'CHANGES_REQUESTED'],
    ['dismissed approval', [{ id: 1, state: 'APPROVED', user: { login: 'alice' } }, { id: 2, state: 'DISMISSED', user: { login: 'alice' } }, { state: 'APPROVED', user: { login: 'bob' } }], 'REVIEW_REQUIRED'],
    ['unavailable', null, null],
  ])('uses the same aggregate decision for dashboard lists: %s', async (label, reviews, decision) => {
    const config = { ...github, token: `dashboard-rollup-${label}` };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return jsonResponse(true, { items: [{
        number: 5, title: 'Example', created_at: '2026-09-17T00:00:00Z', state: 'open',
        user: { login: config.author }, repository_url: 'https://api.github.com/repos/octo/repo',
      }] });
      if (url.pathname.endsWith('/reviews')) return jsonResponse(true, reviews);
      throw new Error(`unexpected url: ${url.href}`);
    }));
    expect((await fetchAuthoredPrs(config))[0]?.reviewDecision).toBe(decision);
  });

  it('caches each review page for dashboard reads', async () => {
    const config = { ...github, token: 'paginated-review-cache' };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return jsonResponse(true, { items: [{
        number: 5, title: 'Example', created_at: '2026-09-17T00:00:00Z', state: 'open',
        user: { login: config.author }, repository_url: 'https://api.github.com/repos/octo/repo',
      }] });
      if (url.pathname.endsWith('/reviews') && url.searchParams.get('page') === '2') return jsonResponse(true, [{ state: 'APPROVED', user: { login: config.author } }, { state: 'APPROVED', user: { login: 'another-reviewer' } }]);
      if (url.pathname.endsWith('/reviews')) return jsonResponse(true, [], {
        link: '<https://api.github.com/repos/octo/repo/pulls/5/reviews?per_page=100&page=2>; rel="next"',
      });
      throw new Error(`unexpected url: ${url.href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchAuthoredPrs(config))[0]?.reviewDecision).toBe('APPROVED');
    expect((await fetchAuthoredPrs(config))[0]?.reviewDecision).toBe('APPROVED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses dashboard reads while fetching current PR status and reviews fresh', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/search/issues') return jsonResponse(true, { items: [{
        number: 5, title: 'Example', created_at: '2026-09-17T00:00:00Z', state: 'open',
        user: { login: github.author }, repository_url: 'https://api.github.com/repos/octo/repo',
      }] });
      if (url.pathname.endsWith('/reviews')) return jsonResponse(true, []);
      if (url.pathname.endsWith('/check-runs')) return jsonResponse(true, { check_runs: [] });
      return jsonResponse(true, { state: 'open', head: { ref: 'feature', sha: 'abc' }, html_url: 'u' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([fetchAuthoredPrs(github), fetchOpenAuthoredPrs(github)]);
    await Promise.all([fetchAuthoredPrs(github), fetchOpenAuthoredPrs(github)]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await fetchPrStatus(github, 'octo/repo', 5);
    await fetchPrStatus(github, 'octo/repo', 5);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/reviews'))).toHaveLength(3);
  });
});
