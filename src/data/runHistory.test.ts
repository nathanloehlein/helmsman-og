import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRunHistory } from './runHistory';

const run = { id: 'run-1', ticketId: 'TODO-1', repo: 'org/alpha', status: 'succeeded', attempt: 1,
  prNumber: null, startedAt: '2026-09-19T00:00:00Z', costUsd: null };
const page = { runs: [run], total: 26, limit: 25, offset: 25 };

afterEach(() => vi.unstubAllGlobals());

describe('fetchRunHistory', () => {
  it('requests a scoped page and preserves history metadata', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(page)));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRunHistory('org/alpha', 25)).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledWith('/api/runs?limit=25&offset=25&repo=org%2Falpha', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('requests all repositories by default and permits an empty page beyond the new total', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...page, runs: [], total: 0, offset: 0 })));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRunHistory(null)).resolves.toMatchObject({ runs: [], offset: 0, total: 0 });
    expect(fetch).toHaveBeenCalledWith('/api/runs?limit=25&offset=0', expect.any(Object));
    fetch.mockImplementation(async () => new Response(JSON.stringify({ ...page, runs: [], total: 12 })));
    await expect(fetchRunHistory(null, 25)).resolves.toMatchObject({ runs: [], total: 12 });
  });

  it('surfaces server and transport failures instead of showing an empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'History unavailable' }), { status: 503 })));
    await expect(fetchRunHistory(null)).rejects.toThrow('History unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(fetchRunHistory(null)).rejects.toThrow('Could not load history (502).');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network offline'); }));
    await expect(fetchRunHistory(null)).rejects.toThrow('Network offline');
  });

  it.each([null, {}, { ...page, runs: [null] }, { ...page, total: -1 }, { ...page, offset: 0 },
    { ...page, limit: 100 }, { ...page, runs: [{ ...run, repo: 'org/other' }] },
    { ...page, runs: [{ ...run, costUsd: -1 }] }, { ...page, runs: [{ ...run, ticketId: null }] },
    { ...page, runs: [run, run] },
  ])('rejects malformed or mismatched history %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(fetchRunHistory('org/alpha', 25)).rejects.toThrow('History response was invalid.');
  });

  it.each([-1, 1.5, Infinity, NaN])('rejects invalid offsets before fetching (%s)', async offset => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRunHistory(null, offset)).rejects.toThrow('offset');
    expect(fetch).not.toHaveBeenCalled();
  });
});
