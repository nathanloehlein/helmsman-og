import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocalGit, mutateLocalGit } from './local-git';

const run = promisify(execFile);
let root: string;
let checkout: string;

async function git(...args: string[]): Promise<string> {
  return (await run('git', ['-C', checkout, ...args], { encoding: 'utf8' })).stdout;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'helmsman local git ')));
  checkout = join(root, 'repo');
  await mkdir(checkout);
  await git('init', '--initial-branch=main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial');
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('getLocalGit', () => {
  it('lists local branches, upstreams and linked, detached, locked and prunable worktrees without changing them', async () => {
    const lockedPath = join(root, 'linked with spaces\nand newline');
    const detachedPath = join(root, 'detached checkout');
    const stalePath = join(root, 'stale checkout');
    await git('branch', 'feature/harbor');
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git('config', 'remote.origin.url', 'https://example.com/owner/repo.git');
    await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git('branch', '--set-upstream-to=origin/main', 'main');
    await git('worktree', 'add', lockedPath, 'feature/harbor');
    await git('worktree', 'lock', '--reason', 'hold for review', lockedPath);
    await git('worktree', 'add', '--detach', detachedPath);
    await git('worktree', 'add', '-b', 'feature/stale', stalePath);
    await rm(stalePath, { recursive: true, force: true });
    await writeFile(join(checkout, 'untracked.txt'), 'preserve');
    const beforeTrees = await git('worktree', 'list', '--porcelain', '-z');
    const beforeStatus = await git('status', '--porcelain');
    const commit = (await git('rev-parse', 'HEAD')).trim();

    const result = await getLocalGit(root, 'owner/repo', ['owner/repo']);

    expect(result.status).toBe(200);
    expect(result.json.error).toBeNull();
    expect(result.json.path).toBe(checkout);
    expect(result.json.branches).toEqual([
      expect.objectContaining({ name: 'feature/harbor', current: false, upstream: null, upstreamStatus: 'none', commit }),
      expect.objectContaining({ name: 'feature/stale', current: false, upstream: null, upstreamStatus: 'none', commit }),
      expect.objectContaining({ name: 'main', current: true, upstream: 'origin/main', upstreamStatus: 'present', commit }),
    ]);
    expect(result.json.worktrees).toHaveLength(4);
    expect(result.json.worktrees).toContainEqual(expect.objectContaining({ path: lockedPath, branch: 'feature/harbor', commit, bare: false, detached: false, locked: true, prunable: false }));
    expect(result.json.worktrees).toContainEqual(expect.objectContaining({ path: detachedPath, branch: null, commit, bare: false, detached: true, locked: false, prunable: false }));
    expect(result.json.worktrees).toContainEqual(expect.objectContaining({ path: stalePath, branch: 'feature/stale', commit, bare: false, detached: false, locked: false, prunable: true }));
    expect(await git('worktree', 'list', '--porcelain', '-z')).toBe(beforeTrees);
    expect(await git('status', '--porcelain')).toBe(beforeStatus);
  });

  it('handles an unborn repository', async () => {
    await mkdir(join(root, 'empty'));
    await run('git', ['init', '--initial-branch=main', join(root, 'empty')]);
    const { json } = await getLocalGit(root, 'owner/empty', ['owner/empty']);
    expect(json.error).toBeNull();
    expect(json.branches).toEqual([]);
    expect(json.worktrees).toHaveLength(1);
    expect(json.worktrees[0]?.branch).toBe('main');
  });

  it('handles bare repositories', async () => {
    const barePath = join(root, 'bare');
    await run('git', ['clone', '--bare', checkout, barePath]);
    const { json } = await getLocalGit(root, 'owner/bare', ['owner/bare']);
    expect(json.error).toBeNull();
    expect(json.branches[0]?.name).toBe('main');
    expect(json.worktrees).toEqual([expect.objectContaining({ path: barePath, branch: null, commit: '', bare: true, detached: false, locked: false, prunable: false })]);
  });

  it('rejects malformed and unconfigured repositories before exposing paths', async () => {
    for (const repo of ['../repo', 'owner/..', 'owner/repo/extra', '/tmp/repo', 'owner/%2e%2e']) {
      const result = await getLocalGit(root, repo, [repo]);
      expect(result.status).toBe(400);
      expect(result.json.path).toBeNull();
    }
    const result = await getLocalGit(root, 'other/repo', ['owner/repo']);
    expect(result.status).toBe(404);
    expect(result.json.path).toBeNull();
  });

  it('returns an explicit empty error response for missing and invalid checkouts', async () => {
    const missing = await getLocalGit(root, 'owner/missing', ['owner/missing']);
    expect(missing.json).toEqual({ repo: 'owner/missing', path: join(root, 'missing'), branches: [], worktrees: [], error: 'Local checkout is missing or inaccessible.' });
    await mkdir(join(root, 'invalid'));
    const invalid = await getLocalGit(root, 'owner/invalid', ['owner/invalid']);
    expect(invalid.json.error).toBe('Unable to read the configured Git checkout.');
    expect(invalid.json.branches).toEqual([]);
  });

  it('does not accidentally enumerate a parent repository', async () => {
    await mkdir(join(checkout, 'nested'));
    const { json } = await getLocalGit(checkout, 'owner/nested', ['owner/nested']);
    expect(json.error).toBe('Configured checkout is not a Git repository.');
    expect(json.branches).toEqual([]);
    expect(json.worktrees).toEqual([]);
  });
});

describe('local Git mutations', () => {
  const repo = 'owner/repo';
  const configured = [repo];
  const sha = async () => (await git('rev-parse', 'HEAD')).trim();
  const mutate = (action: unknown, options = {}) => mutateLocalGit(root, repo, configured, action, options);

  it('deletes a merged branch and returns the refreshed listing', async () => {
    await git('branch', 'feature/merged');
    await git('config', 'branch.feature/merged.description', 'temporary branch');
    const result = await mutate({ action: 'delete-branch', branch: 'feature/merged', expectedCommit: await sha() });
    expect(result.status).toBe(200);
    expect(result.json.branches.map(branch => branch.name)).toEqual(['main']);
    expect(await git('config', '--list')).not.toContain('branch.feature/merged.');
  });

  it('requires explicit force to delete unmerged work', async () => {
    await git('checkout', '-b', 'feature/unmerged');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'unmerged');
    const expectedCommit = await sha();
    await git('checkout', 'main');
    const action = { action: 'delete-branch', branch: 'feature/unmerged', expectedCommit };
    expect((await mutate(action)).status).toBe(409);
    expect((await git('branch', '--list', 'feature/unmerged')).trim()).toBe('feature/unmerged');
    expect((await mutate({ ...action, force: true })).status).toBe(200);
    expect((await git('branch', '--list', 'feature/unmerged')).trim()).toBe('');
  });

  it('protects main, master, remote default, current and checked-out branches even with force', async () => {
    await git('branch', 'master');
    await git('branch', 'trunk');
    await git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    await git('worktree', 'add', '-b', 'feature/linked', join(root, 'linked'));
    await git('checkout', '-b', 'feature/current');
    for (const branch of ['main', 'master', 'trunk', 'feature/linked', 'feature/current']) {
      const result = await mutate({ action: 'delete-branch', branch, expectedCommit: await sha(), force: true });
      expect(result.status, branch).toBe(409);
      expect(result.json.error).toMatch(/protected|checked out/);
    }
  });

  it('rejects stale branch and worktree commits', async () => {
    await git('branch', 'feature/stale');
    const path = join(root, 'linked');
    await git('worktree', 'add', path, 'feature/stale');
    const result = await mutate({ action: 'delete-worktree', path, expectedCommit: 'f'.repeat(40) });
    expect(result.json.error).toMatch(/changed/);
    await git('worktree', 'remove', path);
    expect((await mutate({ action: 'delete-branch', branch: 'feature/stale', expectedCommit: 'f'.repeat(40) })).json.error).toMatch(/changed/);
  });

  it('serializes overlapping mutations against the same checkout', async () => {
    await git('branch', 'feature/once');
    const action = { action: 'delete-branch', branch: 'feature/once', expectedCommit: await sha() };
    const results = await Promise.all([mutate(action), mutate(action)]);
    expect(results.map(result => result.status)).toEqual([200, 404]);
  });

  it('atomically preserves a branch advanced after the preflight SHA check', async () => {
    await git('branch', 'feature/race');
    const expectedCommit = await sha();
    const advanced = (await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'advanced')).trim();
    const realGit = (await run('which', ['git'], { encoding: 'utf8' })).stdout.trim();
    const wrapperDir = join(root, 'git-wrapper');
    await mkdir(wrapperDir);
    await writeFile(join(wrapperDir, 'git'), `#!/bin/sh
if [ "$3" = "update-ref" ] && [ "$4" = "--no-deref" ] && [ "$5" = "-d" ]; then
  "$HELMSMAN_TEST_GIT_BIN" -C "$2" update-ref "$6" "$HELMSMAN_TEST_REPLACEMENT"
fi
exec "$HELMSMAN_TEST_GIT_BIN" "$@"
`, { mode: 0o755 });
    const previous = { PATH: process.env.PATH, HELMSMAN_TEST_GIT_BIN: process.env.HELMSMAN_TEST_GIT_BIN, HELMSMAN_TEST_REPLACEMENT: process.env.HELMSMAN_TEST_REPLACEMENT };
    Object.assign(process.env, { PATH: `${wrapperDir}:${process.env.PATH ?? ''}`, HELMSMAN_TEST_GIT_BIN: realGit, HELMSMAN_TEST_REPLACEMENT: advanced });
    try {
      expect((await mutate({ action: 'delete-branch', branch: 'feature/race', expectedCommit, force: true })).status).toBe(409);
      expect((await git('rev-parse', 'refs/heads/feature/race')).trim()).toBe(advanced);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('removes only a clean registered worktree and preserves its local branch', async () => {
    const path = join(root, 'linked with spaces');
    await git('worktree', 'add', '-b', 'feature/clean', path);
    const result = await mutate({ action: 'delete-worktree', path, expectedCommit: await sha() });
    expect(result.status).toBe(200);
    expect(result.json.worktrees).toHaveLength(1);
    expect(result.json.branches.some(branch => branch.name === 'feature/clean')).toBe(true);
  });

  it('protects symbolic branch aliases and their checked-out targets', async () => {
    await git('symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    const expectedCommit = await sha();
    const state = await getLocalGit(root, repo, configured);
    expect(state.json.branches.find(branch => branch.name === 'alias')).toMatchObject({ deletionBlockedReason: 'Symbolic branch references are protected.' });
    expect((await mutate({ action: 'delete-branch', branch: 'alias', expectedCommit, force: true })).status).toBe(409);
    expect((await git('rev-parse', 'refs/heads/main')).trim()).toBe(expectedCommit);
    expect((await git('symbolic-ref', 'refs/heads/alias')).trim()).toBe('refs/heads/main');
  });

  it('never dereferences a branch changed into a symbolic alias after preflight', async () => {
    await git('branch', 'feature/race');
    const expectedCommit = await sha();
    const realGit = (await run('which', ['git'], { encoding: 'utf8' })).stdout.trim();
    const wrapperDir = join(root, 'git-wrapper');
    await mkdir(wrapperDir);
    await writeFile(join(wrapperDir, 'git'), `#!/bin/sh
if [ "$3" = "update-ref" ] && [ "$4" = "--no-deref" ] && [ "$5" = "-d" ]; then
  "$HELMSMAN_TEST_GIT_BIN" -C "$2" symbolic-ref "$6" refs/heads/main
fi
exec "$HELMSMAN_TEST_GIT_BIN" "$@"
`, { mode: 0o755 });
    const previous = { PATH: process.env.PATH, HELMSMAN_TEST_GIT_BIN: process.env.HELMSMAN_TEST_GIT_BIN };
    Object.assign(process.env, { PATH: `${wrapperDir}:${process.env.PATH ?? ''}`, HELMSMAN_TEST_GIT_BIN: realGit });
    try {
      await mutate({ action: 'delete-branch', branch: 'feature/race', expectedCommit, force: true });
      expect((await git('rev-parse', 'refs/heads/main')).trim()).toBe(expectedCommit);
      expect(await sha()).toBe(expectedCommit);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('refuses primary, locked, protected-default and active worktrees', async () => {
    const locked = join(root, 'locked');
    const active = join(root, 'active');
    const protectedTree = join(root, 'protected');
    await git('worktree', 'add', '-b', 'feature/locked', locked);
    await git('worktree', 'lock', locked);
    await git('worktree', 'add', '--detach', active);
    await git('worktree', 'add', '-b', 'master', protectedTree);
    for (const path of [checkout, locked, active, protectedTree]) {
      const result = await mutate({ action: 'delete-worktree', path, expectedCommit: await sha() }, { activeWorktreePaths: () => [active] });
      expect(result.status, path).toBe(409);
    }
  });

  it('rechecks active run ownership immediately before removal', async () => {
    const path = join(root, 'becomes active');
    await git('worktree', 'add', '--detach', path);
    let calls = 0;
    const result = await mutate({ action: 'delete-worktree', path, expectedCommit: await sha() }, { activeWorktreePaths: () => ++calls === 1 ? [] : [path] });
    expect(result.status).toBe(409);
    expect(result.json.error).toMatch(/active run/);
    expect(await git('worktree', 'list')).toContain(path);
  });

  it('refuses dirty or untracked worktrees without a force escape hatch', async () => {
    const path = join(root, 'dirty');
    await git('worktree', 'add', '--detach', path);
    await writeFile(join(path, 'untracked.txt'), 'keep');
    expect((await mutate({ action: 'delete-worktree', path, expectedCommit: await sha() })).status).toBe(409);
    expect((await mutate({ action: 'delete-worktree', path, expectedCommit: await sha(), force: true })).status).toBe(400);
    expect(await git('worktree', 'list')).toContain(path);
  });

  it('preserves ignored files that Git would otherwise silently delete', async () => {
    const path = join(root, 'ignored');
    await git('worktree', 'add', '--detach', path);
    await writeFile(join(checkout, '.git', 'info', 'exclude'), '.env\n');
    await writeFile(join(path, '.env'), 'PRIVATE=keep');
    const result = await mutate({ action: 'delete-worktree', path, expectedCommit: await sha() });
    expect(result.status).toBe(409);
    expect(result.json.error).toMatch(/ignored files/);
    expect(await git('worktree', 'list')).toContain(path);
  });

  it('rejects mismatched or missing GitHub origin identity', async () => {
    await git('branch', 'feature/keep');
    const action = { action: 'delete-branch', branch: 'feature/keep', expectedCommit: await sha() };
    await git('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    expect((await mutate(action)).json.error).toMatch(/origin does not match/);
    await git('remote', 'remove', 'origin');
    expect((await mutate(action)).json.error).toMatch(/origin does not match/);
    await git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    expect((await mutate(action)).status).toBe(200);
  });

  it('rejects checkout and Git metadata symlink escapes', async () => {
    await git('branch', 'feature/keep');
    const action = { action: 'delete-branch', branch: 'feature/keep', expectedCommit: await sha() };
    const moved = join(root, 'elsewhere');
    await rename(checkout, moved);
    await symlink(moved, checkout, 'dir');
    expect((await mutate(action)).json.error).toMatch(/outside its expected location/);
    await rm(checkout);
    await rename(moved, checkout);
    await rename(join(checkout, '.git'), moved);
    await symlink(moved, join(checkout, '.git'), 'dir');
    expect((await mutate(action)).json.error).toMatch(/metadata outside/);
    expect((await git('branch', '--list', 'feature/keep')).trim()).toBe('feature/keep');
  });

  it('rejects unregistered paths, malformed actions and unconfigured repositories', async () => {
    const expectedCommit = await sha();
    expect((await mutate({ action: 'delete-worktree', path: root, expectedCommit })).status).toBe(404);
    for (const action of [null, [], {}, { action: 'unknown' }, { action: 'delete-branch', branch: '--all', expectedCommit }, { action: 'delete-branch', branch: 'main', expectedCommit, force: 'true' }, { action: 'delete-worktree', path: '../repo', expectedCommit }, { action: 'delete-branch', branch: 'main', expectedCommit: 'HEAD' }]) {
      expect((await mutate(action)).status).toBe(400);
    }
    expect((await mutateLocalGit(root, 'other/repo', configured, { action: 'refresh-remotes' })).status).toBe(404);
    expect((await mutateLocalGit(root, '../repo', ['../repo'], { action: 'refresh-remotes' })).status).toBe(400);
    expect((await mutateLocalGit(root, repo, [repo, 'other/repo'], { action: 'refresh-remotes' })).status).toBe(409);
  });

  it('only updates remote tracking refs when explicitly requested, then identifies gone upstreams', async () => {
    const remote = join(root, 'remote.git');
    await run('git', ['clone', '--bare', checkout, remote]);
    await git('config', `url.${remote}.insteadOf`, 'https://github.com/owner/repo.git');
    await git('push', 'origin', 'main:feature/removed');
    await git('fetch', 'origin');
    await git('branch', '--track', 'feature/removed', 'origin/feature/removed');
    await git('branch', 'feature/local');
    await run('git', ['-C', remote, 'update-ref', '-d', 'refs/heads/feature/removed']);
    const before = await getLocalGit(root, repo, configured);
    expect(before.json.branches.find(branch => branch.name === 'feature/removed')).toMatchObject({ upstreamStatus: 'present' });
    const after = await mutate({ action: 'refresh-remotes' });
    expect(after.status).toBe(200);
    expect(after.json.branches.find(branch => branch.name === 'feature/removed')).toMatchObject({ upstream: 'origin/feature/removed', upstreamStatus: 'gone' });
    expect(after.json.branches.find(branch => branch.name === 'feature/local')).toMatchObject({ upstream: null, upstreamStatus: 'none' });
    await git('config', 'branch.feature/local.merge', 'refs/heads/missing');
    const unknown = await getLocalGit(root, repo, configured);
    expect(unknown.json.branches.find(branch => branch.name === 'feature/local')).toMatchObject({ upstreamStatus: 'unknown' });
  });

  it('returns a bounded remote refresh error without exposing remote URLs', async () => {
    const remote = join(root, 'missing-sensitive-remote');
    await git('config', `url.${remote}.insteadOf`, 'https://github.com/owner/repo.git');
    const result = await mutate({ action: 'refresh-remotes' });
    expect(result.status).toBe(409);
    expect(result.json.error).toMatch(/Unable to refresh remotes/);
    expect(result.json.error).not.toContain(remote);
    expect(result.json.branches).toHaveLength(1);
  });

  it('ignores mirror and custom fetch settings when refreshing remote tracking branches', async () => {
    const remote = join(root, 'remote.git');
    await run('git', ['clone', '--bare', checkout, remote]);
    await git('config', `url.${remote}.insteadOf`, 'https://github.com/owner/repo.git');
    await git('config', 'remote.origin.fetch', '+refs/*:refs/*');
    await git('config', 'remote.origin.mirror', 'true');
    await git('config', 'fetch.pruneTags', 'true');
    await git('branch', 'feature/local-only');
    await git('tag', 'local-only');
    const result = await mutate({ action: 'refresh-remotes' });
    expect(result.status).toBe(200);
    expect(result.json.branches.some(branch => branch.name === 'feature/local-only')).toBe(true);
    expect((await git('tag', '--list')).trim()).toBe('local-only');
    expect((await git('rev-parse', 'refs/remotes/origin/main')).trim()).toBe(await sha());
  });
});
