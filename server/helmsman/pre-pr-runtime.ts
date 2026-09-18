import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentEvent, AgentTask } from './agents/adapter';
import { codexAdapter } from './agents/codex';
import { claudeCodeAdapter } from './agents/claude-code';
import { runPrePrWorkflow, type PrePrReviewerId } from './pre-pr-workflow';
import { selectReviewModel, type ReviewScope } from './review-policy';
import { DEFAULT_PRE_PR_SETTINGS, normalizePrePrSettings, type PrePrSettings } from '../../src/logic/prePrSettings';

const exec = promisify(execFile);
const adapters: Record<PrePrReviewerId, AgentAdapter> = { codex: codexAdapter, 'claude-code': claudeCodeAdapter };
const STAGE_TIMEOUT = DEFAULT_PRE_PR_SETTINGS.stageTimeoutMinutes * 60_000;

export function githubRepository(remote: string): string | null {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parsePrMetadata(value: unknown, task?: Pick<AgentTask, 'ticketId' | 'task'>): { title: string; body: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing PR metadata');
  const { title, body } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim() || title.length > 256 || /[\r\n\u0000]/.test(title)
    || typeof body !== 'string' || !body.trim() || body.length > 64_000 || body.includes('\0')) throw new Error('Invalid PR metadata');
  if (task && !task.task && !title.split(/[^a-zA-Z0-9_-]+/).includes(task.ticketId)) throw new Error('PR title must include the Jira ticket ID');
  return { title: title.trim(), body };
}

export function localReviewScope(numstat: string, headSha: string): ReviewScope {
  const files = numstat.split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!match?.[3]) throw new Error('Invalid local diff scope');
    return { filename: match[3], changes: Number(match[1] === '-' ? 0 : match[1]) + Number(match[2] === '-' ? 0 : match[2]), patch: null };
  });
  return { files, headSha, complete: true, changedFiles: files.length, changedLines: files.reduce((sum, file) => sum + file.changes, 0) };
}

export async function readPrePrReport(path: string): Promise<unknown> {
  const limit = 256 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Report missing or exceeds 256 KB');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Report exceeds 256 KB');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

async function installed(command: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { await access(join(dir, command), constants.X_OK); if ((await stat(join(dir, command))).isFile()) return true; } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

export async function executePrePrStage(adapter: AgentAdapter, task: AgentTask, cwd: string, emit: (event: AgentEvent) => void,
  signal: AbortSignal, timeoutMs = STAGE_TIMEOUT): Promise<void> {
  if (signal.aborted) throw new Error('Voyage stopped');
  const command = adapter.buildCommand(task);
  await new Promise<void>((done, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command.cmd, command.args, { cwd, env: process.env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killStage = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') failure ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    const stop = (message: string) => {
      failure ??= new Error(message);
      killStage('SIGTERM');
      killTimer ??= setTimeout(() => killStage('SIGKILL'), 5000);
      killTimer.unref();
    };
    const abort = () => stop('Voyage stopped');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Agent stage timed out'), timeoutMs);
    let stdout = '';
    let stderr = '';
    const forward = (line: string, error = false) => {
      if (!line.trim()) return;
      if (!error && adapter.id === 'claude-code') {
        try {
          const value = JSON.parse(line) as { type?: string; is_error?: boolean; subtype?: string } | null;
          if (value?.type === 'result' && (value.is_error === true || value.subtype?.startsWith('error'))) failure ??= new Error('Agent reported an unsuccessful result');
        } catch { /* Non-JSON diagnostic output is handled by the adapter. */ }
      }
      let event: AgentEvent | null;
      try { event = error ? { kind: 'log' as const, text: line } : adapter.parseLine(line); }
      catch { stop('Agent emitted malformed output'); return; }
      if (!event) return;
      const { prNumber: _prNumber, ...safe } = event;
      if (safe.kind === 'error') failure ??= new Error('Agent reported an error');
      emit(safe);
    };
    const consume = (chunk: string, error: boolean) => {
      let buffer = (error ? stderr : stdout) + chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { forward(buffer.slice(0, index), error); buffer = buffer.slice(index + 1); }
      if (buffer.length > 1024 * 1024) { stop('Agent emitted an oversized output line'); buffer = ''; }
      if (error) stderr = buffer; else stdout = buffer;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => consume(chunk, false));
    child.stderr.setEncoding('utf8').on('data', chunk => consume(chunk, true));
    child.once('error', error => { failure = error; });
    child.once('exit', () => killStage('SIGKILL'));
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      killStage('SIGKILL');
      signal.removeEventListener('abort', abort);
      forward(stdout); forward(stderr, true);
      if (failure) reject(failure);
      else if (code !== 0 || exitSignal) reject(new Error(`Agent exited ${exitSignal ?? code}`));
      else done();
    });
    if (signal.aborted) abort();
  });
}

export async function runPrePrRuntime(input: { task: AgentTask; writerId: PrePrReviewerId; runsDir: string; settings?: PrePrSettings }, emit: (event: AgentEvent) => void): Promise<number> {
  const cwd = process.cwd();
  const settings = normalizePrePrSettings(input.settings);
  const abort = new AbortController();
  const stopped = () => abort.abort();
  process.once('SIGTERM', stopped);
  process.once('SIGINT', stopped);
  process.once('SIGHUP', stopped);
  const command = async (file: string, args: string[], dir = cwd) => {
    if (abort.signal.aborted) throw new Error('Voyage stopped');
    const result = await exec(file, args, { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, signal: abort.signal });
    return result.stdout.replace(/\r?\n$/, '');
  };
  const git = (args: string[], dir = cwd) => command('git', args, dir);
  let remote = '';
  const matchesRepository = async (name: string) => {
    for (const args of [['remote', 'get-url', '--all', name], ['remote', 'get-url', '--push', '--all', name]]) {
      const urls = (await git(args)).split('\n');
      if (!urls.length || urls.some(url => githubRepository(url) !== input.task.repo.toLowerCase())) return false;
    }
    return true;
  };
  const validateRemote = async () => {
    if (!remote || !(await matchesRepository(remote))) throw new Error('Selected remote does not match the voyage GitHub repository');
  };
  try {
    if (!adapters[input.writerId]) throw new Error('Unsupported writer CLI');
    const reviewerIds: PrePrReviewerId[] = [];
    for (const id of [input.writerId, input.writerId === 'codex' ? 'claude-code' : 'codex'] as PrePrReviewerId[]) {
      if (reviewerIds.length >= settings.reviewerCount) break;
      if (await installed(id === 'codex' ? 'codex' : 'claude')) reviewerIds.push(id);
      else if (id === input.writerId) throw new Error('The writer CLI is unavailable');
    }
    emit({ kind: 'phase', text: `Pre-PR gate: ${reviewerIds.length} reviewer(s), up to ${settings.maxRounds} rounds, ${settings.stageTimeoutMinutes} minutes per session` });
    const initialHead = await git(['rev-parse', 'HEAD']);
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (await git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Author worktree must start clean');
    const matchingRemotes: string[] = [];
    for (const name of (await git(['remote'])).split('\n').filter(Boolean)) {
      if (await matchesRepository(name)) matchingRemotes.push(name);
    }
    remote = matchingRemotes.includes('origin') ? 'origin' : matchingRemotes.length === 1 ? matchingRemotes[0] ?? '' : '';
    if (!remote) throw new Error('Cannot select an unambiguous remote matching the voyage GitHub repository');
    const repository: unknown = JSON.parse(await command('gh', ['repo', 'view', input.task.repo, '--json', 'nameWithOwner,defaultBranchRef']));
    const repo = repository as { nameWithOwner?: string; defaultBranchRef?: { name?: string } } | null;
    const baseBranch = repo?.defaultBranchRef?.name;
    if (repo?.nameWithOwner?.toLowerCase() !== input.task.repo.toLowerCase() || !baseBranch || baseBranch.startsWith('-')) throw new Error('Cannot determine the repository default branch');
    await git(['check-ref-format', '--branch', baseBranch]);
    if (branch === baseBranch) throw new Error('Voyage must use a feature branch');
    await git(['fetch', '--no-tags', remote, `refs/heads/${baseBranch}`]);
    const baseSha = await git(['merge-base', initialHead, 'FETCH_HEAD']);
    const artifactDir = resolve(input.runsDir, `${basename(cwd)}.pre-pr`);
    const relativeArtifacts = relative(cwd, artifactDir);
    if (!relativeArtifacts || (!relativeArtifacts.startsWith('..') && !isAbsolute(relativeArtifacts))) throw new Error('Pre-PR artifacts must be outside the author worktree');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    let metadataPath = '';
    const runStage = async (id: PrePrReviewerId, task: AgentTask, dir: string) => {
      let stageCost = 0;
      await executePrePrStage(adapters[id], task, dir, event => {
        const { costUsd, ...safe } = event;
        const nextCost = Number.isFinite(costUsd) && (costUsd ?? -1) >= 0 ? Math.max(stageCost, costUsd ?? 0) : stageCost;
        const delta = nextCost - stageCost;
        stageCost = nextCost;
        emit({ ...safe, ...(delta > 0 ? { costUsd: delta } : {}) });
      }, abort.signal, settings.stageTimeoutMinutes * 60_000);
    };
    const snapshot = async () => {
      const headSha = await git(['rev-parse', 'HEAD']);
      await git(['merge-base', '--is-ancestor', baseSha, headSha]);
      return { baseSha, headSha, branch: await git(['symbolic-ref', '--quiet', '--short', 'HEAD']), clean: !(await git(['status', '--porcelain', '--untracked-files=all'])) };
    };
    return await runPrePrWorkflow(input.task, {
      writerId: input.writerId, reviewerIds, maxRounds: settings.maxRounds, snapshot, isStopped: () => abort.signal.aborted,
      onPhase: text => emit({ kind: 'phase', text }),
      runAuthor: async (stage, context) => {
        metadataPath = join(artifactDir, `${stage}-${context.round}.json`);
        await rm(metadataPath, { force: true });
        await runStage(input.writerId, { ...input.task, prePr: { stage, ...context, reportPath: metadataPath } }, cwd);
        parsePrMetadata(await readPrePrReport(metadataPath), input.task);
        if (!(await git(['diff', '--name-only', baseSha, 'HEAD']))) throw new Error('Author produced an empty overall diff');
      },
      review: async (reviewerId, context) => {
        if (reviewerId !== 'codex' && reviewerId !== 'claude-code') throw new Error('Unsupported reviewer');
        const scope = localReviewScope(await git(['diff', '--numstat', '--no-renames', '-z', context.baseSha, context.headSha]), context.headSha);
        const choice = selectReviewModel(scope, reviewerId);
        emit({ kind: 'phase', text: `${reviewerId} review: ${choice.effort} effort — ${choice.reason}` });
        const root = await mkdtemp(join(tmpdir(), 'helmsman-review-'));
        const worktree = join(root, 'checkout');
        const reportPath = join(artifactDir, `review-${context.round}-${reviewerId}.json`);
        try {
          await rm(reportPath, { force: true });
          await git(['worktree', 'add', '--detach', worktree, context.headSha]);
          await runStage(reviewerId, { ...input.task, model: choice.model, effort: choice.effort,
            prePr: { stage: 'review', ...context, reportPath } }, worktree);
          if ((await git(['rev-parse', 'HEAD'], worktree)) !== context.headSha
            || await git(['status', '--porcelain', '--untracked-files=all'], worktree)) throw new Error('Reviewer modified its immutable worktree');
          return await readPrePrReport(reportPath);
        } finally {
          try { await exec('git', ['worktree', 'remove', '--force', worktree], { cwd, timeout: 15_000 }); } catch { /* Failed worktree creation needs no git cleanup. */ }
          await rm(root, { recursive: true, force: true });
        }
      },
      publish: async expected => {
        const metadata = parsePrMetadata(await readPrePrReport(metadataPath), input.task);
        const assertApproved = async () => {
          const actual = await snapshot();
          if (!actual.clean || actual.branch !== branch || actual.headSha !== expected.headSha || actual.baseSha !== expected.baseSha) throw new Error('Approved revision changed before publication');
          await validateRemote();
        };
        await assertApproved();
        await git(['push', remote, `${expected.headSha}:refs/heads/${branch}`]);
        await assertApproved();
        const assertRemoteApproved = async () => {
          const remoteRevision = await git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
          if (remoteRevision !== `${expected.headSha}\trefs/heads/${branch}`) throw new Error('Remote branch does not match the approved revision; PR publication blocked');
        };
        await assertRemoteApproved();
        const findPr = async (): Promise<number | null> => {
          const value: unknown = JSON.parse(await command('gh', ['pr', 'list', '--repo', input.task.repo, '--head', branch, '--state', 'open', '--json', 'number,headRefOid,baseRefName']));
          if (!Array.isArray(value)) throw new Error('Invalid GitHub PR list response');
          for (const pr of value) {
            if (!pr || typeof pr !== 'object') throw new Error('Invalid GitHub PR response');
            if (pr.headRefOid !== expected.headSha || pr.baseRefName !== baseBranch) throw new Error('Existing PR does not match the approved revision and base');
            if (Number.isSafeInteger(pr.number) && pr.number > 0) return pr.number;
          }
          return null;
        };
        const existing = await findPr();
        if (existing) return existing;
        const bodyFile = join(artifactDir, 'pr-body.md');
        await writeFile(bodyFile, metadata.body, { mode: 0o600 });
        await assertApproved();
        await assertRemoteApproved();
        await command('gh', ['pr', 'create', '--repo', input.task.repo, '--head', branch, '--base', baseBranch, '--title', metadata.title, '--body-file', bodyFile]);
        const created = await findPr();
        if (!created) throw new Error('Created PR could not be verified');
        return created;
      },
    });
  } finally {
    process.removeListener('SIGTERM', stopped);
    process.removeListener('SIGINT', stopped);
    process.removeListener('SIGHUP', stopped);
  }
}
