import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPrOwnership } from './github-pr-ownership';

const github = { token: 'token', author: 'configured-user', repo: 'org/repo' };

afterEach(() => vi.unstubAllGlobals());

function responses(viewer: unknown, pr: unknown, status = 200) {
  const fetcher = vi.fn(async (url: string | URL) => new Response(JSON.stringify(url.toString().endsWith('/user') ? viewer : pr), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('fetchPrOwnership', () => {
  it.each([' VIEWER ', 'CONFIGURED-USER'])('recognizes own PR authored by %s', async (login) => {
    responses({ login: 'viewer' }, { user: { login } });
    expect(await fetchPrOwnership(github, 'org/repo', 42)).toBe(true);
  });

  it('confirms another author only with authenticated identity and PR author', async () => {
    const fetcher = responses({ login: 'viewer' }, { user: { login: 'someone-else' } });
    expect(await fetchPrOwnership(github, 'org/repo', 42)).toBe(false);
    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      'https://api.github.com/user', 'https://api.github.com/repos/org/repo/pulls/42',
    ]);
  });

  it.each([
    [null, { user: { login: 'another' } }],
    [{ login: '' }, { user: { login: 'another' } }],
    [{ login: 42 }, { user: { login: 'another' } }],
    [{ login: 'viewer' }, null],
    [{ login: 'viewer' }, { user: null }],
    [{ login: 'viewer' }, { user: { login: ' ' } }],
  ])('does not infer ownership from incomplete identity %j / %j', async (viewer, pr) => {
    responses(viewer, pr);
    expect(await fetchPrOwnership(github, 'org/repo', 42)).toBeNull();
  });

  it.each([401, 403, 404, 500])('retains unknown ownership on HTTP %s', async (status) => {
    responses({ login: 'viewer' }, { user: { login: 'another' } }, status);
    expect(await fetchPrOwnership(github, 'org/repo', 42)).toBeNull();
  });

  it('retains unknown ownership after network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchPrOwnership(github, 'org/repo', 42)).toBeNull();
  });

  it('rejects missing credentials and invalid PR identifiers before fetching', async () => {
    const fetcher = responses({}, {});
    expect(await fetchPrOwnership(null, 'org/repo', 42)).toBeNull();
    expect(await fetchPrOwnership(github, 'org/repo/../../user', 42)).toBeNull();
    expect(await fetchPrOwnership(github, 'org/repo', 0)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
