import { describe, expect, it, vi } from 'vitest';
import { sweepOrphanedWorktrees } from './worktree';

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
