import { execFile } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import { access, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { LocalGitResponse } from '../src/data/localGit';
import { isGithubRepo } from './pr-lists';
import { repoBasename } from './helmsman/worktree';

const run = promisify(execFile);
const mutationLocks = new Map<string, Promise<unknown>>();

type Branch = LocalGitResponse['branches'][number] & {
  upstreamStatus: 'present' | 'gone' | 'none' | 'unknown';
  deletionBlockedReason: string | null;
};
type Worktree = LocalGitResponse['worktrees'][number] & { deletionBlockedReason: string | null };
export interface LocalGitOptions { activeWorktreePaths?: () => string[] }
export interface BranchCleanup {
  force: boolean;
  expectedHead: string;
  candidates: { branch: string; expectedCommit: string; upstreamStatus: 'none' | 'gone' }[];
  skipped: { branch: string; reason: string }[];
}

type LocalGitResult = { status: number; json: LocalGitResponse & { cleanup?: BranchCleanup } };

export type LocalGitAction =
  | { action: 'preview-delete-untracked-branches'; force?: boolean }
  | { action: 'delete-untracked-branches'; expectedHead: string; branches: { branch: string; expectedCommit: string }[]; force?: boolean }
  | { action: 'delete-branch'; branch: string; expectedCommit: string; force?: boolean }
  | { action: 'delete-worktree'; path: string; expectedCommit: string }
  | { action: 'refresh-remotes' };

async function git(path: string, args: string[], timeout = 10_000): Promise<string> {
  const result = await run('git', ['-C', path, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout;
}

class BranchCleanupConflict extends Error {}

async function linkedWorktreeGitDirs(path: string): Promise<string[]> {
  const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const directory = join(common, 'worktrees');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)).sort();
}

function preparedRefTransaction(
  location: string[], commands: string[], whilePrepared: () => Promise<void>, finish: 'commit' | 'abort', controller: AbortController,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let checking = false;
    let finishing = false;
    let output = '';
    let checkError: unknown;
    const child = execFile('git', [...location, 'update-ref', '--no-deref', '--stdin'], {
      encoding: 'utf8', signal: controller.signal, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (error, _stdout, stderr) => {
      const failure = checkError ?? (controller.signal.aborted ? controller.signal.reason : error ? Object.assign(error, { stderr }) : !finishing ? new BranchCleanupConflict('Git released a cleanup lock before deletion completed. Refresh and try again.') : null);
      if (failure) { controller.abort(failure); reject(failure); }
      else resolve();
    });
    child.stdout?.on('data', (data: string | Buffer) => {
      output += data.toString();
      if (checking || !/prepare: ok\r?\n/.test(output)) return;
      checking = true;
      void whilePrepared().then(() => {
        controller.signal.throwIfAborted();
        finishing = true;
        child.stdin?.end(`${finish}\n`);
      }).catch(error => {
        checkError = error;
        finishing = true;
        child.stdin?.end('abort\n');
      });
    });
    child.stdin?.on('error', error => { controller.abort(error); reject(error); });
    child.stdin?.write(['start', ...commands, 'prepare', ''].join('\n'));
  });
}

async function deleteBranchRefs(path: string, branches: { branch: string; expectedCommit: string }[], expectedHead?: string): Promise<void> {
  const gitDirs = await linkedWorktreeGitDirs(path);
  const head = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
  const linkedHeads = await Promise.all(gitDirs.map(async gitDir => ({
    gitDir, commit: (await git(path, [`--git-dir=${gitDir}`, 'rev-parse', '--verify', 'HEAD'])).trim(),
  })));
  const controller = new AbortController();
  setMaxListeners(linkedHeads.length + 2, controller.signal);
  const verifyOwnership = async () => {
    const latestDirs = await linkedWorktreeGitDirs(path);
    const trees = parseWorktrees(await git(path, ['worktree', 'list', '--porcelain', '-z']));
    if (latestDirs.length !== gitDirs.length || latestDirs.some((dir, index) => dir !== gitDirs[index])
      || trees.some(tree => branches.some(branch => tree.branch === branch.branch))) {
      throw new BranchCleanupConflict('Worktree ownership changed. Refresh and preview branch cleanup again.');
    }
    if (expectedHead && head !== expectedHead) throw new BranchCleanupConflict('Current HEAD changed. Preview branch cleanup again.');
  };
  const deleteRefs = () => preparedRefTransaction(['-C', path], [
    `verify HEAD ${head}`,
    ...branches.map(branch => `delete refs/heads/${branch.branch} ${branch.expectedCommit}`),
  ], verifyOwnership, 'commit', controller);
  const lockLinkedHead = async (index: number): Promise<void> => {
    const linked = linkedHeads[index];
    if (!linked) return deleteRefs();
    await preparedRefTransaction(['--git-dir', linked.gitDir], [`verify HEAD ${linked.commit}`], () => lockLinkedHead(index + 1), 'abort', controller);
  };
  const deadline = setTimeout(() => controller.abort(new BranchCleanupConflict('Branch cleanup timed out. Refresh and try again.')), 10_000);
  try { await lockLinkedHead(0); }
  finally { clearTimeout(deadline); controller.abort(); }
}

async function cleanupPreview(path: string, branches: Branch[], force: boolean): Promise<BranchCleanup> {
  const expectedHead = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
  const candidates: BranchCleanup['candidates'] = [];
  const skipped: BranchCleanup['skipped'] = [];
  for (const branch of branches) {
    if (branch.upstreamStatus !== 'none' && branch.upstreamStatus !== 'gone') continue;
    let reason = branch.deletionBlockedReason;
    if (!reason && !force) {
      try { await git(path, ['merge-base', '--is-ancestor', branch.commit, expectedHead]); }
      catch { reason = 'Branch is not fully merged into the current HEAD.'; }
    }
    if (reason) skipped.push({ branch: branch.name, reason });
    else candidates.push({ branch: branch.name, expectedCommit: branch.commit, upstreamStatus: branch.upstreamStatus });
  }
  return { force, expectedHead, candidates, skipped };
}

function parseBranches(output: string, config: string): Branch[] {
  const configuredUpstreams = new Set(config.split('\0').map(entry => entry.split('\n')[0]));
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [name, head, upstream, commit, tracking, upstreamRef, symbolicRef] = line.split('\0');
    if (!name || !commit) return [];
    const upstreamStatus = upstreamRef ? (tracking === '[gone]' ? 'gone' : 'present')
      : configuredUpstreams.has(`branch.${name}.merge`) ? 'unknown' : 'none';
    return [{ name, current: head === '*', upstream: upstream || null, commit, upstreamStatus, deletionBlockedReason: symbolicRef ? 'Symbolic branch references are protected.' : null }];
  });
}

function parseWorktrees(output: string): Worktree[] {
  return output.split('\0\0').filter(Boolean).flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!path) return [];
    const branch = fields.find((field) => field.startsWith('branch '))?.slice(7);
    return [{
      // Git reports worktree paths with forward slashes on Windows, while every
      // path this module is handed comes from node:path. Normalize once here so
      // the reported path and every comparison against it agree. A no-op for
      // absolute POSIX paths.
      path: resolve(path),
      branch: branch?.replace(/^refs\/heads\//, '') ?? null,
      commit: fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '',
      bare: fields.includes('bare'),
      detached: fields.includes('detached'),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
      deletionBlockedReason: null,
    }];
  });
}

async function activePaths(options: LocalGitOptions): Promise<Set<string>> {
  const paths = options.activeWorktreePaths?.() ?? [];
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('Active worktree state is unavailable.');
  }
  return new Set((await Promise.all(paths.map(async path => [resolve(path), await realpath(path).catch(() => resolve(path))]))).flat());
}

function githubOriginRepo(origin: string): string | null {
  const scp = /^git@github\.com:([^\s]+)$/i.exec(origin);
  if (scp?.[1]) return scp[1].replace(/\.git\/?$/, '').replace(/\/$/, '');
  try {
    const url = new URL(origin);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.search || url.hash) return null;
    return url.pathname.replace(/^\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  } catch { return null; }
}

async function mutationCheckoutError(agentsRoot: string, repo: string, path: string): Promise<string | null> {
  const canonical = await realpath(path);
  if (canonical !== join(await realpath(agentsRoot), repoBasename(repo))) return 'Configured checkout resolves outside its expected location.';
  const common = await realpath((await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (common !== canonical && !common.startsWith(`${canonical}${sep}`)) return 'Configured checkout uses Git metadata outside its expected location.';
  const origins = (await git(path, ['config', '--get-all', 'remote.origin.url']).catch(() => '')).trim().split('\n').filter(Boolean);
  if (origins.length !== 1 || githubOriginRepo(origins[0] ?? '')?.toLowerCase() !== repo.toLowerCase()) return 'Configured checkout origin does not match this GitHub galleon.';
  return null;
}

export async function getLocalGit(
  agentsRoot: string,
  repo: string,
  configuredRepos: string[],
  options: LocalGitOptions = {},
): Promise<{ status: number; json: LocalGitResponse }> {
  const empty: LocalGitResponse = { repo, path: null, branches: [], worktrees: [], error: null };
  if (typeof repo !== 'string' || !isGithubRepo(repo)) return { status: 400, json: { ...empty, error: 'Galleon must be owner/name.' } };
  if (!configuredRepos.includes(repo)) return { status: 404, json: { ...empty, error: 'Galleon is not configured.' } };
  if (configuredRepos.some(other => other !== repo && repoBasename(other) === repoBasename(repo))) {
    return { status: 409, json: { ...empty, error: 'Configured galleons share the same local checkout name.' } };
  }
  const path = resolve(agentsRoot, repoBasename(repo));
  empty.path = path;
  try {
    await access(path);
  } catch {
    return { status: 200, json: { ...empty, error: 'Local checkout is missing or inaccessible.' } };
  }
  try {
    const gitDir = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
    const hasGitEntry = await access(join(path, '.git')).then(() => true, () => false);
    if (!hasGitEntry && await realpath(path) !== await realpath(gitDir)) {
      return { status: 200, json: { ...empty, error: 'Configured checkout is not a Git repository.' } };
    }
    const [branchOutput, treeOutput, defaultsOutput, config, active, canonicalPath] = await Promise.all([
      git(path, ['for-each-ref', '--sort=refname', '--format=%(refname:strip=2)%00%(HEAD)%00%(upstream:short)%00%(objectname)%00%(upstream:track)%00%(upstream)%00%(symref)%00', 'refs/heads/']),
      git(path, ['worktree', 'list', '--porcelain', '-z']),
      git(path, ['for-each-ref', '--format=%(refname)%00%(symref)%00', 'refs/remotes/']),
      git(path, ['config', '--null', '--list']),
      activePaths(options),
      realpath(path),
    ]);
    const defaults = new Set(['main', 'master']);
    for (const line of defaultsOutput.split('\n')) {
      const [ref, target] = line.split('\0');
      if (ref?.endsWith('/HEAD') && target?.startsWith('refs/remotes/')) {
        const branch = target.replace(/^refs\/remotes\/[^/]+\//, '');
        defaults.add(branch);
      }
    }
    const branches = parseBranches(branchOutput, config);
    const worktrees = parseWorktrees(treeOutput);
    for (const [index, tree] of worktrees.entries()) {
      tree.deletionBlockedReason = tree.bare ? 'Bare repositories cannot be removed.'
        : index === 0 || resolve(tree.path) === canonicalPath ? 'The primary or configured checkout cannot be removed.'
        : tree.locked ? 'Worktree is locked.'
        : tree.prunable ? 'Worktree is missing or inaccessible.'
        : active.has(resolve(tree.path)) ? 'Worktree belongs to an active run.'
        : tree.branch && defaults.has(tree.branch) ? 'Worktree contains a protected default branch.' : null;
    }
    for (const branch of branches) {
      branch.deletionBlockedReason ??= defaults.has(branch.name) ? 'Default branches are protected.'
        : branch.current || worktrees.some(tree => tree.branch === branch.name) ? 'Branch is checked out in a worktree.' : null;
    }
    return { status: 200, json: { ...empty, branches, worktrees } };
  } catch {
    return { status: 200, json: { ...empty, error: 'Unable to read the configured Git checkout.' } };
  }
}

function parseAction(input: unknown): LocalGitAction | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.action === 'refresh-remotes') return { action: value.action };
  if (value.action === 'preview-delete-untracked-branches') {
    if (value.force !== undefined && typeof value.force !== 'boolean') return null;
    return { action: value.action, force: value.force === true };
  }
  if (value.action === 'delete-untracked-branches') {
    if ((value.force !== undefined && typeof value.force !== 'boolean') || typeof value.expectedHead !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.expectedHead)
      || !Array.isArray(value.branches) || value.branches.length === 0 || value.branches.length > 1000) return null;
    const branches: { branch: string; expectedCommit: string }[] = [];
    for (const entry of value.branches) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const target = entry as Record<string, unknown>;
      if (typeof target.branch !== 'string' || !target.branch || target.branch.startsWith('-') || /[\s\0]/.test(target.branch)
        || typeof target.expectedCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target.expectedCommit)
        || branches.some(branch => branch.branch === target.branch)) return null;
      branches.push({ branch: target.branch, expectedCommit: target.expectedCommit });
    }
    return { action: value.action, expectedHead: value.expectedHead, branches, force: value.force === true };
  }
  if (typeof value.expectedCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.expectedCommit)) return null;
  if (value.action === 'delete-branch' && typeof value.branch === 'string' && value.branch.length > 0 && !value.branch.startsWith('-')
    && (value.force === undefined || typeof value.force === 'boolean')) {
    return { action: value.action, branch: value.branch, expectedCommit: value.expectedCommit, force: value.force };
  }
  if (value.action === 'delete-worktree' && typeof value.path === 'string' && isAbsolute(value.path) && !value.path.includes('\0') && value.force === undefined) {
    return { action: value.action, path: value.path, expectedCommit: value.expectedCommit };
  }
  return null;
}

export async function mutateLocalGit(
  agentsRoot: string,
  repo: string,
  configuredRepos: string[],
  input: unknown,
  options: LocalGitOptions = {},
): Promise<LocalGitResult> {
  const action = parseAction(input);
  if (!action) return { status: 400, json: { repo, path: null, branches: [], worktrees: [], error: 'Invalid local Git action.' } };
  const lockKey = resolve(agentsRoot, typeof repo === 'string' ? repoBasename(repo) : '');
  const previous = mutationLocks.get(lockKey) ?? Promise.resolve();
  const mutation = previous.catch(() => undefined).then(async () => {
    const state = await getLocalGit(agentsRoot, repo, configuredRepos, options);
    const fail = (status: number, error: string) => ({ status, json: { ...state.json, error } });
    if (state.status !== 200 || state.json.error || !state.json.path) return state.status === 200 ? fail(409, state.json.error ?? 'Checkout unavailable.') : state;
    const path = state.json.path;
    try {
      const checkoutError = await mutationCheckoutError(agentsRoot, repo, path);
      if (checkoutError) return fail(409, checkoutError);
      if (action.action === 'preview-delete-untracked-branches') {
        return { status: 200, json: { ...state.json, cleanup: await cleanupPreview(path, state.json.branches as Branch[], action.force === true) } };
      }
      if (action.action === 'delete-untracked-branches') {
        const preview = await cleanupPreview(path, state.json.branches as Branch[], action.force === true);
        if (preview.expectedHead !== action.expectedHead) return fail(409, 'Current HEAD changed. Preview branch cleanup again.');
        for (const target of action.branches) {
          await git(path, ['check-ref-format', `refs/heads/${target.branch}`]);
          const candidate = preview.candidates.find(branch => branch.branch === target.branch);
          if (!candidate || candidate.expectedCommit !== target.expectedCommit) return fail(409, `Branch ${target.branch} changed or is no longer safe to delete. Preview cleanup again.`);
        }
        const latest = await getLocalGit(agentsRoot, repo, configuredRepos, options);
        if (latest.status !== 200 || latest.json.error) return fail(409, 'Unable to recheck branch safety. Preview cleanup again.');
        for (const target of action.branches) {
          const branch = latest.json.branches.find(branch => branch.name === target.branch);
          if (!branch || branch.commit !== target.expectedCommit || branch.deletionBlockedReason
            || (branch.upstreamStatus !== 'none' && branch.upstreamStatus !== 'gone')) return fail(409, `Branch ${target.branch} changed or is no longer safe to delete. Preview cleanup again.`);
        }
        if ((await git(path, ['rev-parse', '--verify', 'HEAD'])).trim() !== action.expectedHead) return fail(409, 'Current HEAD changed. Preview branch cleanup again.');
        await deleteBranchRefs(path, action.branches, action.expectedHead);
        let metadataIncomplete = false;
        try {
          const config = await git(path, ['config', '--null', '--list']);
          for (const target of action.branches) {
            if (config.split('\0').some(entry => entry.split('\n')[0]?.startsWith(`branch.${target.branch}.`))) {
              await git(path, ['config', '--remove-section', `branch.${target.branch}`]).catch(() => { metadataIncomplete = true; });
            }
          }
        } catch { metadataIncomplete = true; }
        const refreshed = await getLocalGit(agentsRoot, repo, configuredRepos, options);
        return metadataIncomplete ? {
          status: 200,
          json: { ...refreshed.json, error: 'Branches deleted, but Git could not remove all saved branch settings. Review those settings before reusing the branch names.' },
        } : refreshed;
      } else if (action.action === 'refresh-remotes') {
        const remotes = (await git(path, ['remote'])).split('\n').filter(Boolean);
        for (const remote of remotes) {
          await git(path, ['check-ref-format', `refs/remotes/${remote}/helmsman-validation`]);
          await git(path, ['fetch', '--prune', '--no-tags', '--no-prune-tags', '--no-recurse-submodules', '--refmap=', '--', remote, `+refs/heads/*:refs/remotes/${remote}/*`], 120_000);
        }
      } else if (action.action === 'delete-branch') {
        const branch = state.json.branches.find(item => item.name === action.branch) as Branch | undefined;
        if (!branch) return fail(404, 'Local branch no longer exists.');
        if (branch.deletionBlockedReason) return fail(409, branch.deletionBlockedReason);
        if (branch.commit !== action.expectedCommit) return fail(409, 'Branch changed. Refresh before deleting.');
        await git(path, ['check-ref-format', `refs/heads/${action.branch}`]);
        const current = (await git(path, ['rev-parse', '--verify', `refs/heads/${action.branch}`])).trim();
        if (current !== action.expectedCommit) return fail(409, 'Branch changed. Refresh before deleting.');
        if (action.force !== true) {
          const mergeTarget = branch.upstreamStatus === 'present'
            ? (await git(path, ['rev-parse', '--verify', `refs/heads/${action.branch}@{upstream}`])).trim()
            : (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
          try { await git(path, ['merge-base', '--is-ancestor', action.expectedCommit, mergeTarget]); }
          catch { return fail(409, 'Branch is not fully merged. Force deletion requires explicit confirmation.'); }
        }
        const trees = parseWorktrees(await git(path, ['worktree', 'list', '--porcelain', '-z']));
        await activePaths(options);
        if (trees.some(tree => tree.branch === action.branch)) return fail(409, 'Branch is checked out in a worktree.');
        await deleteBranchRefs(path, [{ branch: action.branch, expectedCommit: action.expectedCommit }]);
        const config = await git(path, ['config', '--null', '--list']);
        if (config.split('\0').some(entry => entry.split('\n')[0]?.startsWith(`branch.${action.branch}.`))) {
          await git(path, ['config', '--remove-section', `branch.${action.branch}`]);
        }
      } else {
        const tree = state.json.worktrees.find(item => item.path === resolve(action.path)) as Worktree | undefined;
        if (!tree) return fail(404, 'Worktree is not registered with this galleon.');
        if (tree.deletionBlockedReason) return fail(409, tree.deletionBlockedReason);
        if (tree.commit !== action.expectedCommit) return fail(409, 'Worktree changed. Refresh before deleting.');
        const [common, treeCommon, head, canonicalTree] = await Promise.all([
          git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          git(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          git(tree.path, ['rev-parse', '--verify', 'HEAD']),
          realpath(tree.path),
        ]);
        if (await realpath(common.trim()) !== await realpath(treeCommon.trim()) || canonicalTree !== resolve(tree.path)) {
          return fail(409, 'Worktree identity changed. Refresh before deleting.');
        }
        if (head.trim() !== action.expectedCommit) return fail(409, 'Worktree changed. Refresh before deleting.');
        const latest = parseWorktrees(await git(path, ['worktree', 'list', '--porcelain', '-z'])).find(item => item.path === tree.path);
        if (!latest || latest.branch !== tree.branch || latest.commit !== action.expectedCommit || latest.locked || latest.bare || latest.prunable) {
          return fail(409, 'Worktree changed. Refresh before deleting.');
        }
        if ((await git(tree.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).length > 0) {
          return fail(409, 'Worktree contains ignored files. Move or remove them before deleting the worktree.');
        }
        if ((await activePaths(options)).has(canonicalTree)) return fail(409, 'Worktree belongs to an active run.');
        await git(path, ['worktree', 'remove', '--', tree.path]);
      }
      return await getLocalGit(agentsRoot, repo, configuredRepos, options);
    } catch (error) {
      const refreshed = await getLocalGit(agentsRoot, repo, configuredRepos, options);
      if (action.action === 'refresh-remotes') return { status: 409, json: { ...refreshed.json, error: 'Unable to refresh remotes. Check network access and Git authentication.' } };
      const details = error instanceof BranchCleanupConflict ? error.message : error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 1500) : '';
      return { status: 409, json: { ...refreshed.json, error: details || 'Local Git action failed. Refresh and try again.' } };
    }
  });
  mutationLocks.set(lockKey, mutation);
  try { return await mutation; }
  finally { if (mutationLocks.get(lockKey) === mutation) mutationLocks.delete(lockKey); }
}
