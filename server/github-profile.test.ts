import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGithubProfile } from './github-profile';

const github = { token: 'secret-token', author: 'configured-handle', repo: 'org/app' };
const response = (data: unknown) => new Response(JSON.stringify(data));

afterEach(() => vi.unstubAllGlobals());

describe('fetchGithubProfile', () => {
  it('reads the authenticated display name once and caches it without exposing private profile fields', async () => {
    const fetcher = vi.fn(async () => response({ name: ' Captain Example ', login: 'captain', email: 'private@example.com', token: 'secret' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchGithubProfile(github)).toEqual({ displayName: 'Captain Example', login: 'captain' });
    expect(await fetchGithubProfile(github)).toEqual({ displayName: 'Captain Example', login: 'captain' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL('https://api.github.com/user'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }), signal: expect.any(AbortSignal),
    }));
  });

  it.each([null, '', '   ', 42])('uses the authenticated handle when the display name is absent: %j', async name => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ name, login: 'captain' })));
    expect(await fetchGithubProfile(github)).toEqual({ displayName: 'captain', login: 'captain' });
  });

  it.each([null, {}, [], { name: null, login: 123 }])('falls back to configured author for malformed profiles: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body)));
    expect(await fetchGithubProfile(github)).toEqual({ displayName: 'configured-handle', login: 'configured-handle' });
  });

  it('isolates cached profiles when credentials change', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ login: 'first' })).mockResolvedValueOnce(response({ login: 'second' }));
    vi.stubGlobal('fetch', fetcher);
    expect((await fetchGithubProfile(github)).login).toBe('first');
    expect((await fetchGithubProfile({ ...github, token: 'second-token' })).login).toBe('second');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses the configured handle for HTTP and network failures without returning error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('private error', { status: 401 })).mockRejectedValueOnce(new Error('secret-token')));
    for (let i = 0; i < 2; i++) expect(await fetchGithubProfile(github)).toEqual({ displayName: 'configured-handle', login: 'configured-handle' });
  });

  it('does not fetch when GitHub is unconfigured', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchGithubProfile(null)).toEqual({ displayName: null, login: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
