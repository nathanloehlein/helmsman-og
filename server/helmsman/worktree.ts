import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { isGithubRepo } from '../pr-lists';

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

export function repoBasename(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

export async function createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  const branch: string = `agent/${runId}`;
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, path], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}

async function removeWorktreeForBranch(repoDir: string, branch: string): Promise<void> {
  const result = await run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']).catch(() => null);
  if (!result) return;
  const target: string = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === target && currentPath) {
      await removeWorktreeAt(repoDir, currentPath).catch(() => undefined);
      currentPath = null;
    } else if (line === '') currentPath = null;
  }
}

export async function createWorktreeFromBranch(agentsRoot: string, repo: string, runId: string, branch: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await run('git', ['-C', repoDir, 'worktree', 'prune']).catch(() => undefined);
  await removeWorktreeForBranch(repoDir, branch);
  await run('git', ['-C', repoDir, 'fetch', 'origin', `+${branch}:${branch}`], { maxBuffer: 1024 * 1024 * 16 });
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', path, branch], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}

export async function createReviewWorktree(agentsRoot: string, repo: string, runId: string, prNumber: number, headSha: string): Promise<Worktree> {
  if (!isGithubRepo(repo) || !/^[a-z\d_-]{1,128}$/i.test(runId)
    || !Number.isSafeInteger(prNumber) || prNumber < 1 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(headSha)) {
    throw new Error('Invalid pinned PR review worktree parameters');
  }
  const repoDir = join(agentsRoot, repoBasename(repo));
  const path = join(repoDir, '.worktrees', runId);
  const options = { maxBuffer: 1024 * 1024 * 16 };
  await run('git', ['-C', repoDir, 'fetch', '--no-tags', 'origin', `refs/pull/${prNumber}/head`], options);
  const commit = await run('git', ['-C', repoDir, 'rev-parse', '--verify', `${headSha}^{commit}`], options);
  if (commit.stdout.trim().toLowerCase() !== headSha.toLowerCase()) throw new Error('Pinned PR revision is not a commit');
  await run('git', ['-C', repoDir, 'worktree', 'add', '--detach', path, headSha], options);
  return { path, branch: headSha };
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
  } catch (err: unknown) {
    process.stderr.write(`worktree list failed for ${repoDir}: ${String(err)}\n`);
    return [];
  }
}

export async function discoverRepoDirs(agentsRoot: string): Promise<string[]> {
  try {
    const entries: import('node:fs').Dirent[] = await readdir(agentsRoot, { withFileTypes: true });
    return entries
      .filter((entry: import('node:fs').Dirent): boolean => entry.isDirectory())
      .map((entry: import('node:fs').Dirent): string => join(agentsRoot, entry.name))
      .filter((dir: string): boolean => existsSync(join(dir, '.worktrees')));
  } catch (err: unknown) {
    process.stderr.write(`repo-dir discovery failed for ${agentsRoot}: ${String(err)}\n`);
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
