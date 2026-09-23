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
  it('preserves the exact cleanup preview and sends only explicitly confirmed commits', async () => {
    const cleanup = {
      expectedHead: 'head123', force: false, candidates: [{ branch: 'local-topic', expectedCommit: 'abc123', upstreamStatus: 'none' }],
      skipped: [{ branch: 'main', reason: 'Default branch.' }],
    };
    const response = { repo: 'org/repo', path: '/repos/repo', branches: [], worktrees: [], error: null };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...response, cleanup })))
      .mockResolvedValueOnce(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    const preview = await updateLocalGit('org/repo', { action: 'preview-delete-untracked-branches' });
    expect(preview.cleanup).toEqual(cleanup);
    const action = { action: 'delete-untracked-branches' as const, expectedHead: cleanup.expectedHead, branches: cleanup.candidates.map(({ branch, expectedCommit }) => ({ branch, expectedCommit })) };
    await updateLocalGit('org/repo', action);
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ repo: 'org/repo', ...action });
  });

  it.each([
    { expectedHead: 'head123', force: false, candidates: [null], skipped: [] },
    { expectedHead: 'head123', force: false, candidates: [{ branch: 'topic', expectedCommit: '', upstreamStatus: 'none' }], skipped: [] },
    { expectedHead: 'head123', force: false, candidates: [{ branch: 'topic', expectedCommit: 'abc', upstreamStatus: 'present' }], skipped: [] },
    { expectedHead: null, candidates: [], skipped: [] },
    { expectedHead: 'head123', force: 'true', candidates: [], skipped: [] },
    { expectedHead: 'head123', candidates: [], skipped: [] },
  ])('rejects malformed cleanup previews instead of offering an unsafe partial list', async cleanup => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      repo: 'org/repo', path: '/repos/repo', branches: [], worktrees: [], error: null, cleanup,
    }))));
    const result = await updateLocalGit('org/repo', { action: 'preview-delete-untracked-branches' });
    expect(result.cleanup).toBeUndefined();
    expect(result.error).toContain('Refresh local data before retrying');
  });

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

  it('sends pinned release targets and retains server activity and release guards', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      repo: 'org/repo', path: '/repos/repo', branches: [], error: 'Worktree belongs to an active run.',
      worktrees: [{ path: '/repos/topic', branch: 'topic', commit: 'abc', active: true, releaseBlockedReason: 'Worktree belongs to an active run.' }],
    }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const action = { action: 'release-worktree' as const, path: '/repos/topic', expectedCommit: 'abc', expectedBranch: 'topic' };
    const result = await updateLocalGit('org/repo', action);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ repo: 'org/repo', ...action });
    expect(result.worktrees[0]).toMatchObject({ active: true, releaseBlockedReason: 'Worktree belongs to an active run.' });
    expect(result.error).toBe('Worktree belongs to an active run.');
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
