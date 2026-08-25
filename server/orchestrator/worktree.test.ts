import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktreeFromBranch, sweepOrphanedWorktrees, discoverRepoDirs, type Worktree } from './worktree';

const execFileAsync = promisify(execFile);

describe('createWorktreeFromBranch', () => {
  it('checks out an existing branch into a run-scoped worktree without creating a new branch', async () => {
    const agentsRoot: string = await mkdtemp(join(tmpdir(), 'agents-'));
    try {
      const sourceDir: string = join(agentsRoot, 'source');
      await mkdir(sourceDir, { recursive: true });
      await execFileAsync('git', ['-C', sourceDir, 'init', '-q', '-b', 'main']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com']);
      await execFileAsync('git', ['-C', sourceDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', sourceDir, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await execFileAsync('git', ['-C', sourceDir, 'branch', 'fix/x']);

      const repoDir: string = join(agentsRoot, 'repo');
      await execFileAsync('git', ['clone', '-q', sourceDir, repoDir]);

      const result: Worktree = await createWorktreeFromBranch(agentsRoot, 'o/repo', 'run-1', 'fix/x');

      expect(result.branch).toBe('fix/x');
      expect(result.path).toBe(join(repoDir, '.worktrees', 'run-1'));
      expect(existsSync(result.path)).toBe(true);
      const head = await execFileAsync('git', ['-C', result.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(head.stdout.trim()).toBe('fix/x');
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });
});

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
