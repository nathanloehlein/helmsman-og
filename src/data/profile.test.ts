import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProfile } from './profile';

afterEach(() => vi.unstubAllGlobals());

describe('loadProfile', () => {
  it('loads and normalizes the public profile', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ displayName: ' Captain Example ', login: ' captain ', extra: 'ignored' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadProfile()).toEqual({ displayName: 'Captain Example', login: 'captain' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/github/profile', { headers: { Accept: 'application/json' } });
  });

  it('uses the handle when a name is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ displayName: ' ', login: 'captain' }))));
    expect(await loadProfile()).toEqual({ displayName: 'captain', login: 'captain' });
  });

  it.each([null, {}, { displayName: 1, login: [] }])('ignores malformed response fields: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await loadProfile()).toEqual({ displayName: null, login: null });
  });

  it('returns an empty profile for unavailable endpoints and offline clients', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockRejectedValueOnce(new Error('offline')));
    expect(await loadProfile()).toEqual({ displayName: null, login: null });
    expect(await loadProfile()).toEqual({ displayName: null, login: null });
  });
});
