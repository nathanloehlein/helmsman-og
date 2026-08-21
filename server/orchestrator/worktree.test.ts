import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepOrphanedWorktrees, discoverRepoDirs } from './worktree';

describe('sweepOrphanedWorktrees', () => {
  it('removes only orphaned worktrees, leaving active runs untouched', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const removed: string[] = await sweepOrphanedWorktrees({
      repoDirs: ['/agents/r'],
      listAgentWorktrees: async () => ['/agents/r/.worktrees/run-A', '/agents/r/.worktrees/run-B'],
      remove,
      isActiveRunId: (runId: string) => runId === 'run-A',
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-B');
    expect(removed).toEqual(['/agents/r/.worktrees/run-B']);
  });

  it('continues sweeping when one removal rejects', async () => {
    const remove = vi.fn().mockImplementation((_repoDir: string, path: string) => {
      if (path === '/agents/r/.worktrees/run-A') return Promise.reject(new Error('boom'));
      return Promise.resolve(undefined);
    });
    const removed: string[] = await sweepOrphanedWorktrees({
      repoDirs: ['/agents/r'],
      listAgentWorktrees: async () => ['/agents/r/.worktrees/run-A', '/agents/r/.worktrees/run-B'],
      remove,
      isActiveRunId: () => false,
    });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-A');
    expect(remove).toHaveBeenCalledWith('/agents/r', '/agents/r/.worktrees/run-B');
    expect(removed).toEqual(['/agents/r/.worktrees/run-B']);
  });
});

describe('discoverRepoDirs', () => {
  it('returns only subdirectories that contain a .worktrees dir', async () => {
    const root: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      await mkdir(join(root, 'repo-a', '.worktrees'), { recursive: true });
      await mkdir(join(root, 'repo-b'), { recursive: true });
      const dirs: string[] = await discoverRepoDirs(root);
      expect(dirs).toEqual([join(root, 'repo-a')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns [] for a nonexistent root without throwing', async () => {
    const dirs: string[] = await discoverRepoDirs(join(tmpdir(), 'does-not-exist-xyz-123'));
    expect(dirs).toEqual([]);
  });
});
