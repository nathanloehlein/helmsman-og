import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRun, openRunStream, retryRun } from './agents';
import { RUN_LOG_LINE_LIMIT } from '../logic/runLog';

afterEach(() => vi.unstubAllGlobals());

describe('retryRun', () => {
  it('posts the full original ID and returns only the new voyage ID', async () => {
    const id = 'b5fcda70-6766-461d-a828-bd1fe233a580';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: 'new-voyage', ignored: true })));
    vi.stubGlobal('fetch', fetch);
    await expect(retryRun(id)).resolves.toEqual({ runId: 'new-voyage' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/agents/${id}/retry`, { method: 'POST' });
  });

  it.each(['', '../run', 'bad id', 'x'.repeat(129), null, undefined, 42])('rejects invalid IDs without fetching: %j', async id => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(retryRun(id as string)).rejects.toThrow('Invalid voyage ID.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the server error when retry is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Original task is unavailable.' }), { status: 409 })));
    await expect(retryRun('old-run')).rejects.toThrow('Original task is unavailable.');
  });

  it.each(['not-json', 'null', '[]', '{}', '{"error":42}'])('uses the HTTP status for malformed failure responses: %s', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 503 })));
    await expect(retryRun('old-run')).rejects.toThrow('Retry failed (503).');
  });

  it.each([
    null, [], {}, 'new-run', { runId: null }, { runId: 42 }, { runId: '' },
    { runId: '../run' }, { runId: 'x'.repeat(129) }, { runId: 'old-run' },
  ])('rejects invalid or unchanged successful IDs: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(retryRun('old-run')).rejects.toThrow('The server did not return a new voyage ID. Check recent voyages before retrying.');
  });

  it('rejects malformed success JSON without suggesting an automatic retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json')));
    await expect(retryRun('old-run')).rejects.toThrow('Check recent voyages before retrying.');
  });

  it('propagates network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
    await expect(retryRun('old-run')).rejects.toThrow('Network unavailable');
  });
});

describe('openRunStream', () => {
  it('ignores malformed events, bounds preview text, and stops after completion', () => {
    let stream: { onmessage: ((event: MessageEvent<string>) => void) | null; close: ReturnType<typeof vi.fn> };
    vi.stubGlobal('EventSource', class {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      close = vi.fn();
      constructor() { stream = this; }
    });
    const onEvent = vi.fn();
    openRunStream('run-a', onEvent);
    const emit = (data: string) => stream.onmessage?.({ data } as MessageEvent<string>);
    for (const value of ['bad-json', 'null', '{}', '[]', JSON.stringify({ kind: 'log', text: 42 }), JSON.stringify({ kind: 'log', text: 'wrong run', runId: 'run-b' })]) emit(value);
    expect(onEvent).not.toHaveBeenCalled();
    emit(JSON.stringify({ kind: 'log', text: 'x'.repeat(100_000) }));
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ runId: 'run-a', kind: 'log' });
    expect(onEvent.mock.calls[0]?.[0]?.text.length).toBeLessThan(RUN_LOG_LINE_LIMIT + 50);
    emit(JSON.stringify({ kind: 'run-complete', text: 'succeeded' }));
    expect(stream!.close).toHaveBeenCalledOnce();
    emit(JSON.stringify({ kind: 'log', text: 'late event' }));
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe('getRun', () => {
  it('fetches an individual run independently of recent voyage history', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'old-run', ticketId: 'TASK-2', status: 'succeeded', repo: 'owner/repo', prNumber: 42 }) });
    vi.stubGlobal('fetch', fetch);
    expect(await getRun('old-run')).toEqual({ ticketId: 'TASK-2', status: 'succeeded', repo: 'owner/repo', prNumber: 42 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/agents/old-run');
  });

  it('omits a malformed ticket label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'old-run', ticketId: {}, status: 'running', repo: 'owner/repo', prNumber: null }) }));
    expect(await getRun('old-run')).toEqual({ status: 'running', repo: 'owner/repo', prNumber: null });
  });

  it.each([null, {}, { id: 'other-run', status: 'succeeded', repo: 'owner/repo' }, { id: 'old-run', status: null, repo: 'owner/repo' }])('ignores invalid or mismatched API responses: %j', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    expect(await getRun('old-run')).toBeNull();
  });

  it.each([null, undefined, -1, '42', 1.5])('normalizes invalid or absent PR numbers: %j', async (prNumber) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'old-run', status: 'running', repo: 'owner/repo', prNumber }) }));
    expect((await getRun('old-run'))?.prNumber).toBeNull();
  });

  it('returns null for a missing or unavailable run', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    expect(await getRun('missing-run')).toBeNull();
    expect(await getRun('old-run')).toBeNull();
  });

  it.each(['', '../run', 'bad id', 'x'.repeat(129)])('does not fetch invalid IDs: %s', async (id) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await getRun(id)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
