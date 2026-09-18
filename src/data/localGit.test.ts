import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLocalGit, updateLocalGit } from './localGit';

afterEach(() => vi.unstubAllGlobals());

describe('fetchLocalGit', () => {
  it('reads the selected repository and safely normalizes nullable rows', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      repo: 'org/repo', path: '/repos/repo', error: null,
      branches: [null, { name: 'main', current: true, upstream: 'origin/main', commit: '123abc' }],
      worktrees: [null, { path: '/repos/repo', branch: null, commit: '123abc', detached: true }],
    })));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchLocalGit('org/repo');
    expect(fetch).toHaveBeenCalledWith('/api/repo/local?repo=org%2Frepo');
    expect(result.branches).toHaveLength(1);
    expect(result.worktrees).toEqual([{ path: '/repos/repo', branch: null, commit: '123abc', detached: true, bare: false, locked: false, prunable: false }]);
    expect(result.loading).toBe(false);
  });

  it.each([null, { repo: 'org/other', branches: [], worktrees: [] }, { repo: 'org/repo', branches: null, worktrees: [] }])('rejects malformed or mismatched responses', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    const result = await fetchLocalGit('org/repo');
    expect(result.error).toBeTruthy();
    expect(result.branches).toEqual([]);
  });

  it('reports missing checkout and network errors without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockRejectedValueOnce(new Error('offline')));
    expect((await fetchLocalGit('org/repo')).error).toBeTruthy();
    expect((await fetchLocalGit('org/repo')).error).toBeTruthy();
  });
});

describe('updateLocalGit', () => {
  it('preserves actionable API errors and safety metadata on a refused deletion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      repo: 'org/repo', path: '/repos/repo', error: 'Worktree is dirty.',
      branches: [{ name: 'topic', commit: 'abc', upstream: 'origin/topic', upstreamStatus: 'gone', deletionBlockedReason: 'Checked out.' }],
      worktrees: [{ path: '/repos/topic', commit: 'abc', deletionBlockedReason: 'Worktree is dirty.' }],
    }), { status: 409 })));
    const result = await updateLocalGit('org/repo', { action: 'delete-worktree', path: '/repos/topic', expectedCommit: 'abc' });
    expect(result.error).toBe('Worktree is dirty.');
    expect(result.branches[0]?.upstreamStatus).toBe('gone');
    expect(result.branches[0]?.deletionBlockedReason).toBe('Checked out.');
    expect(result.worktrees[0]?.deletionBlockedReason).toBe('Worktree is dirty.');
  });

  it('does not silently accept invalid responses or retry an ambiguous write', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({ repo: 'other', branches: [], worktrees: [] })));
    vi.stubGlobal('fetch', fetch);
    expect((await updateLocalGit('org/repo', { action: 'refresh-remotes' })).error).toContain('Refresh local data before retrying');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await updateLocalGit('org/repo', { action: 'refresh-remotes' })).error).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
