import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

function repoBasename(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

export async function createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  const branch: string = `agent/${runId}`;
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, path], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}

export async function removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
}
