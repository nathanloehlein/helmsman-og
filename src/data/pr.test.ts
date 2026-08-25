import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPrStatus, parsePrUrl, submitReview } from './pr';
import type { PrStatusView } from './pr';

const realFetch: typeof globalThis.fetch | undefined = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch as typeof globalThis.fetch;
});

describe('getPrStatus', () => {
  it('returns the parsed body on a stubbed 200', async () => {
    const payload: PrStatusView = {
      number: 12,
      repo: 'o/r',
      state: 'open',
      draft: false,
      merged: false,
      headRefName: 'feature-branch',
      reviewDecision: 'APPROVED',
      comments: 3,
      checks: { passed: 5, failed: 0, pending: 1 },
      url: 'https://github.com/o/r/pull/12',
    };
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: PrStatusView | null = await getPrStatus('o/r', 12);

    expect(result).toEqual(payload);
  });

  it('returns null on a stubbed non-ok response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: PrStatusView | null = await getPrStatus('o/r', 12);

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result: PrStatusView | null = await getPrStatus('o/r', 12);

    expect(result).toBeNull();
  });

  it('returns null when a stubbed 200 response body is not a valid PrStatusView', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: PrStatusView | null = await getPrStatus('o/r', 12);

    expect(result).toBeNull();
  });
});

describe('submitReview', () => {
  it('returns ok:true on a 200 response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await submitReview('o/r', 12, 'APPROVE', 'looks good');

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the error message on a stubbed 400 response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid review' }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await submitReview('o/r', 12, 'REQUEST_CHANGES', 'needs work');

    expect(result).toEqual({ ok: false, error: 'invalid review' });
  });

  it('returns ok:false when fetch throws', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await submitReview('o/r', 12, 'COMMENT', 'note');

    expect(result).toEqual({ ok: false });
  });
});

describe('parsePrUrl', () => {
  it('parses a full github pull request URL', () => {
    const result: { repo: string; number: number } | null = parsePrUrl('https://github.com/o/r/pull/12');

    expect(result).toEqual({ repo: 'o/r', number: 12 });
  });

  it('parses a short owner/repo#number reference', () => {
    const result: { repo: string; number: number } | null = parsePrUrl('o/r#7');

    expect(result).toEqual({ repo: 'o/r', number: 7 });
  });

  it('returns null for unrecognized input', () => {
    const result: { repo: string; number: number } | null = parsePrUrl('nope');

    expect(result).toBeNull();
  });
});
