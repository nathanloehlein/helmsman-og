import { describe, expect, it, vi } from 'vitest';
import { readHttpFailure } from './http-failure';

describe('readHttpFailure', () => {
  it('uses bounded known JSON error fields', async () => {
    expect(await readHttpFailure(new Response(JSON.stringify({ message: 'GitHub rejected the request' }))))
      .toBe('GitHub rejected the request');
    expect(await readHttpFailure(new Response(JSON.stringify({ errorMessages: ['first', 'second'] }))))
      .toBe('first; second');
    expect(await readHttpFailure(new Response(JSON.stringify({ errors: { field: 'is invalid' } }))))
      .toBe('is invalid');
  });

  it('limits oversized declared and streamed bodies', async () => {
    expect(await readHttpFailure(new Response('x'.repeat(32), { headers: { 'content-length': '32' } }), { maxBytes: 8 }))
      .toBe('response body too large');
    expect(await readHttpFailure(new Response('x'.repeat(32)), { maxBytes: 8 }))
      .toBe('response body too large');
  });

  it('returns a safe fallback when the body does not finish before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({ start() {} });
      const result = readHttpFailure(new Response(body), { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toBe('response body unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back safely for malformed and empty bodies', async () => {
    expect(await readHttpFailure(new Response('{bad'))).toBe('{bad');
    expect(await readHttpFailure(new Response(null))).toBe('request failed');
  });
});

it('does not wait for a stalled cancellation after the read deadline', async () => {
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
  const result = await Promise.race([
    readHttpFailure(new Response(stream), { timeoutMs: 5 }),
    new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
  ]);
  expect(result).toBe('response body unavailable');
});
