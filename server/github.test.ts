import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPrStatus, submitReview } from './github';
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
      url: 'u',
    });
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
