import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthoredPrs, fetchOpenAuthoredPrs, fetchPrStatus, requestCopilotReview, submitReview } from './github';
import type { GithubConfig } from './config';
import type { PrStatus } from './github';

const github: GithubConfig = {
  token: 'tok',
  repo: 'octo/repo',
  author: 'octocat',
};

function jsonResponse(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 200 : 422,
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
      state: 'open',
      draft: false,
      merged: false,
      headRefName: 'fix/x',
      headSha: 'abc',
      reviewDecision: 'REVIEW_REQUIRED',
      comments: 2,
      checks: { passed: 1, failed: 1, pending: 1 },
      reviews: { requested: 0, approved: 0, changesRequested: 0, commented: 0 },
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
