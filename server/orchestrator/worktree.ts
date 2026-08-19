import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, sep } from 'node:path';

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

export async function removeWorktreeAt(repoDir: string, worktreePath: string): Promise<void> {
  await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]);
}

export async function removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await removeWorktreeAt(repoDir, worktreePath).catch(() => undefined);
}

export async function listAgentWorktrees(repoDir: string): Promise<string[]> {
  try {
    const result: { stdout: string; stderr: string } = await run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
    const marker: string = `${sep}.worktrees${sep}`;
    const paths: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path: string = line.slice('worktree '.length).trim();
      if (path.includes(marker)) paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

export interface WorktreeSweepDeps {
  listAgentWorktrees: (repoDir: string) => Promise<string[]>;
  remove: (repoDir: string, path: string) => Promise<void>;
  isActiveRunId: (runId: string) => boolean;
  repoDirs: string[];
}

export async function sweepOrphanedWorktrees(deps: WorktreeSweepDeps): Promise<string[]> {
  const removed: string[] = [];
  for (const repoDir of deps.repoDirs) {
    try {
      const paths: string[] = await deps.listAgentWorktrees(repoDir);
      for (const path of paths) {
        const runId: string = basename(path);
        if (deps.isActiveRunId(runId)) continue;
        try {
          await deps.remove(repoDir, path);
          removed.push(path);
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return removed;
}
