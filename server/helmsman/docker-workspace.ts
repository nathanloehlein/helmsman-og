import { execFile } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RUN = /^[a-z\d_-]{1,128}$/i;
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
export interface DockerWorkspace { path: string; branch: string; }
export interface DockerWorkspaceOptions { source: string; root: string; runId: string; mode: 'fresh' | 'review' | 'branch'; branch?: string; headSha?: string; }
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();

export async function createDockerWorkspace(input: DockerWorkspaceOptions): Promise<DockerWorkspace> {
  if (!RUN.test(input.runId) || !['fresh', 'review', 'branch'].includes(input.mode)) throw new Error('Invalid Docker workspace request');
  const source = await resolve(input.source); const root = resolve(input.root); const path = join(root, input.runId);
  if (relative(root, path).startsWith(`..${sep}`)) throw new Error('Docker workspace escaped its root');
  await lstat(source);
  await exec('git', ['clone', '--no-hardlinks', '--no-local', source, path], { encoding: 'utf8' });
  try {
    await git(path, ['config', '--unset-all', 'credential.helper']).catch(() => undefined);
    await git(path, ['config', '--unset-all', 'core.sshCommand']).catch(() => undefined);
    if (input.mode === 'review') {
      if (!input.headSha || !SHA.test(input.headSha)) throw new Error('Pinned review requires a valid head SHA');
      await git(path, ['checkout', '--detach', input.headSha]); return { path, branch: input.headSha };
    }
    if (!input.branch || input.branch.startsWith('-') || input.branch.includes('..')) throw new Error('Docker workspace requires a valid branch');
    if (input.mode === 'fresh') await git(path, ['checkout', '-b', input.branch]);
    else await git(path, ['checkout', input.branch]);
    return { path, branch: input.branch };
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
}

export async function removeDockerWorkspace(root: string, workspace: string): Promise<void> {
  const base = resolve(root); const path = resolve(workspace);
  if (relative(base, path).startsWith(`..${sep}`) || path === base || !RUN.test(path.split(sep).at(-1) ?? '')) throw new Error('Refusing to remove an unowned Docker workspace');
  await rm(path, { recursive: true, force: true });
}
