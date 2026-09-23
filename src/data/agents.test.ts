import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRun, openRunStream, retryRun } from './agents';
import { RUN_LOG_LINE_LIMIT } from '../logic/runLog';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  function streams() {
    const instances: MockStream[] = [];
    class MockStream {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      readyState = 0;
      close = vi.fn(() => { this.readyState = 2; });
      readonly url: string;
      constructor(url: string) { this.url = url; instances.push(this); }
      open(): void { this.readyState = 1; this.onopen?.(); }
      fail(state = 2): void { this.readyState = state; this.onerror?.(); }
      emit(id: number, text = `line ${id}`, kind = 'log'): void {
        this.onmessage?.({ data: JSON.stringify({ id, runId: 'run-a', kind, text }) } as MessageEvent<string>);
      }
    }
    vi.stubGlobal('EventSource', MockStream);
    return instances;
  }

  it('retries an initial closed connection and replays output when the new run becomes available', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onEvent = vi.fn();
    const onState = vi.fn();
    const close = openRunStream('run-a', onEvent, onState);
    expect(onState).toHaveBeenLastCalledWith('connecting');
    instances[0]!.fail();
    expect(onState).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.url).toBe('/api/agents/run-a/log');
    instances[1]!.open();
    instances[1]!.emit(7, 'Prepared Jira task');
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 7, text: 'Prepared Jira task' }));
    expect(onState.mock.calls.flat()).toEqual(['connecting', 'reconnecting', 'live']);
    close();
  });

  it('limits initial failures to six attempts with bounded backoff, then reports unavailable', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onState = vi.fn();
    openRunStream('run-a', vi.fn(), onState);
    const delays = [1000, 2000, 4000, 5000, 5000];
    for (const [index, delay] of delays.entries()) {
      instances[index]!.fail();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(instances).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(instances).toHaveLength(index + 2);
    }
    instances[5]!.fail();
    expect(onState).toHaveBeenLastCalledWith('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(6);
    expect(instances.every(source => source.close.mock.calls.length === 1)).toBe(true);
  });

  it('lets EventSource reconnect natively and keeps healthy idle connections open', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onState = vi.fn();
    const close = openRunStream('run-a', vi.fn(), onState);
    instances[0]!.open();
    expect(onState).toHaveBeenLastCalledWith('live');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    instances[0]!.fail(0);
    expect(onState).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.close).not.toHaveBeenCalled();
    instances[0]!.open();
    expect(onState).toHaveBeenLastCalledWith('live');
    close();
  });

  it('deduplicates persisted replay IDs across reconnects while retaining live events without IDs', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onEvent = vi.fn();
    const close = openRunStream('run-a', onEvent);
    instances[0]!.emit(10);
    instances[0]!.emit(11);
    instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000);
    instances[1]!.emit(9);
    instances[1]!.emit(10);
    instances[1]!.emit(11);
    instances[1]!.emit(12);
    instances[1]!.emit(0, 'live message');
    instances[1]!.emit(0, 'another live message');
    expect(onEvent.mock.calls.map(([event]) => event.id)).toEqual([10, 11, 12, 0, 0]);
    close();
  });

  it('cancels pending retries and ignores stale callbacks after cleanup', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onEvent = vi.fn();
    const onState = vi.fn();
    const close = openRunStream('run-a', onEvent, onState);
    const staleMessage = instances[0]!.onmessage;
    const staleOpen = instances[0]!.onopen;
    const staleError = instances[0]!.onerror;
    instances[0]!.fail();
    close();
    const states = onState.mock.calls.length;
    staleMessage?.({ data: JSON.stringify({ id: 1, kind: 'log', text: 'late event' }) } as MessageEvent<string>);
    staleOpen?.();
    staleError?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(states);
  });

  it('never reconnects after completion and ignores callbacks from a replaced source', async () => {
    vi.useFakeTimers();
    const instances = streams();
    const onEvent = vi.fn();
    openRunStream('run-a', onEvent);
    const staleMessage = instances[0]!.onmessage;
    instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000);
    staleMessage?.({ data: JSON.stringify({ id: 99, kind: 'run-complete', text: 'failed' }) } as MessageEvent<string>);
    instances[1]!.emit(1, 'completed', 'run-complete');
    instances[1]!.fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 1, kind: 'run-complete' }));
    expect(instances[1]?.close).toHaveBeenCalledOnce();
  });

  it('reports invalid run IDs as unavailable without opening a connection', () => {
    const instances = streams();
    const onState = vi.fn();
    openRunStream('../run', vi.fn(), onState);
    expect(instances).toHaveLength(0);
    expect(onState).toHaveBeenCalledExactlyOnceWith('unavailable');
  });

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
  it.each(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])('preserves the saved %s recommendation for a successful run', async (reviewOutcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'old-run', status: 'succeeded', repo: 'owner/repo', reviewOutcome }) }));
    expect(await getRun('old-run')).toMatchObject({ status: 'succeeded', reviewOutcome });
  });

  it.each([
    ['succeeded', null], ['succeeded', 'constructor'], ['succeeded', '<img src=x onerror=alert(1)>'],
    ['failed', 'APPROVE'], ['running', 'REQUEST_CHANGES'], ['stopped', 'COMMENT'],
  ])('omits an invalid recommendation for %s: %j', async (status, reviewOutcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'old-run', status, repo: 'owner/repo', reviewOutcome }) }));
    expect(await getRun('old-run')).not.toHaveProperty('reviewOutcome');
  });

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
