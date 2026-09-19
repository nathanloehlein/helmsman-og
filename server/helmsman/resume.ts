import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PRE_PR_SETTING_DEFINITIONS, parsePrePrSettingValue, type PrePrSettings } from '../../src/logic/prePrSettings';
import type { AgentTask } from './agents/adapter';
import { codexAdapter } from './agents/codex';
import { claudeCodeAdapter } from './agents/claude-code';
import { isPrePrAdapter, prePrAdapter } from './agents/pre-pr';
import type { Db, RunRow } from './db';
import type { HostRef, RunHost } from './run-host';
import { parsePrMetadata, readPrePrReport } from './pre-pr-runtime';
import { parsePrePrReview, PrePrSummaryTooLongError } from './pre-pr-workflow';

const exec = promisify(execFile);

export class ResumeError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function inspectPrePrContinuation(row: RunRow, runsDir: string) {
  if (row.status !== 'failed' || !isPrePrAdapter(row.adapter) || row.prNumber !== null || !row.worktreePath
    || !/^[a-z\d_-]{1,128}$/i.test(row.id) || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    throw new ResumeError('Only failed pre-PR voyages with a retained worktree can continue.');
  }
  const task = record(JSON.parse(row.taskJson ?? 'null'));
  if (!task || task.repo !== row.repo || task.ticketId !== row.ticketId || typeof task.title !== 'string'
    || typeof task.jiraBaseUrl !== 'string' || task.review || task.prBranch || task.prNumber) {
    throw new ResumeError('The original voyage task is incomplete or cannot continue from a pre-PR checkpoint.');
  }
  if (task.todoId) throw new ResumeError('Local todo voyages must use Retry from Todos.');
  const root = resolve(runsDir);
  const logPath = join(root, `${row.id}.log`);
  const exitPath = join(root, `${row.id}.exit`);
  const specPath = join(root, `${row.id}.json`);
  if (row.logPath !== logPath || row.exitPath !== exitPath || row.specPath !== specPath) {
    throw new ResumeError('The saved voyage files do not match the configured runs directory.');
  }
  for (const path of [logPath, exitPath, specPath]) {
    if (!(await lstat(path)).isFile()) throw new ResumeError('Voyage log, exit marker, and launch specification must be regular files.');
  }
  const exit = (await readFile(exitPath, 'utf8')).trim();
  if (!/^[1-9]\d*$/.test(exit)) throw new ResumeError('The previous worker has not recorded a failed exit.');
  const logSize = (await lstat(logPath)).size;
  if (row.logOffset !== logSize) throw new ResumeError('The original log must be fully processed before continuing.');
  const spec = record(await readPrePrReport(specPath));
  const args = spec?.args;
  const original = Array.isArray(args) && typeof args.at(-1) === 'string' ? record(JSON.parse(args.at(-1))) : null;
  const writerId = row.adapter === 'pre-pr:codex' ? 'codex' : 'claude-code';
  const originalTask = record(original?.task);
  if (spec?.cwd !== row.worktreePath || original?.writerId !== writerId || original?.runsDir !== root
    || originalTask?.repo !== row.repo || originalTask?.ticketId !== row.ticketId) {
    throw new ResumeError('The saved worker specification does not match the voyage.');
  }
  const savedSettings = record(original?.settings);
  const settings = {} as PrePrSettings;
  for (const definition of PRE_PR_SETTING_DEFINITIONS) {
    const value = parsePrePrSettingValue(savedSettings?.[definition.key], definition);
    if (value === undefined) throw new ResumeError('The saved review settings are missing or invalid.');
    settings[definition.key] = value;
  }
  const cwd = await realpath(row.worktreePath);
  const git = async (args: string[]) => (await exec('git', args, { cwd, timeout: 15_000, encoding: 'utf8' })).stdout.trim();
  if (basename(cwd) !== row.id || await realpath(await git(['rev-parse', '--show-toplevel'])) !== cwd
    || await git(['status', '--porcelain', '--untracked-files=all'])) throw new ResumeError('The retained voyage worktree must be clean and unchanged.');
  const headSha = await git(['rev-parse', 'HEAD']);
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== `agent/${row.id}`) throw new ResumeError('The retained voyage branch has changed.');
  const artifactDir = join(root, `${row.id}.pre-pr`);
  if (!(await lstat(artifactDir)).isDirectory()) throw new ResumeError('The review checkpoint directory is unavailable.');
  const files = await readdir(artifactDir);
  const rounds = files.flatMap(file => {
    const match = /^review-([1-5])-(?:codex|claude-code)\.json$/.exec(file);
    return match ? [Number(match[1])] : [];
  });
  const round = Math.max(0, ...rounds);
  if (!round || round > settings.maxRounds) throw new ResumeError('There is no valid completed review round to continue.');
  const reviewers = settings.reviewerCount === 1 ? [writerId] : [writerId, writerId === 'codex' ? 'claude-code' : 'codex'];
  const reviewerReports: Record<string, string> = {};
  let baseSha = '';
  for (const reviewer of reviewers) {
    const path = join(artifactDir, `review-${round}-${reviewer}.json`);
    const value = await readPrePrReport(path);
    const raw = record(value);
    if (!baseSha && typeof raw?.baseSha === 'string') baseSha = raw.baseSha;
    try { parsePrePrReview(value, { baseSha, headSha }); }
    catch (error) { if (!(error instanceof PrePrSummaryTooLongError)) throw error; }
    reviewerReports[reviewer] = path;
  }
  await git(['merge-base', '--is-ancestor', baseSha, headSha]);
  if (baseSha === headSha) throw new ResumeError('The checkpoint contains no committed implementation.');
  const metadataPath = join(artifactDir, round === 1 ? 'implement-0.json' : `fix-${round - 1}.json`);
  parsePrMetadata(await readPrePrReport(metadataPath), task as unknown as AgentTask);
  const resumedTask: AgentTask = { ...task as unknown as AgentTask, prePrResume: { baseSha, headSha, branch, round, reviewerReports, metadataPath } };
  return { task: resumedTask, settings, writerId, cwd: row.worktreePath, logPath, exitPath, specPath, logSize };
}

export async function resumeFailedPrePrRun(row: RunRow, deps: { db: Db; host: RunHost; runsDir: string; now(): string; isStopped?(): boolean }): Promise<RunRow> {
  let checkpoint: Awaited<ReturnType<typeof inspectPrePrContinuation>>;
  try { checkpoint = await inspectPrePrContinuation(row, deps.runsDir); }
  catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError(`The retained review checkpoint could not be verified: ${error instanceof Error ? error.message : 'invalid checkpoint'}`);
  }
  if (deps.isStopped?.()) throw new ResumeError('Continuation was cancelled before launch.');
  const priorRef = record(row.hostRef ? JSON.parse(row.hostRef) : null);
  if (row.hostKind !== deps.host.kind || !priorRef || priorRef.kind !== deps.host.kind
    || priorRef.kind === 'detached' && (!Number.isSafeInteger(priorRef.pid) || Number(priorRef.pid) < 1)
    || priorRef.kind === 'cmux' && typeof priorRef.workspace !== 'string') {
    throw new ResumeError('The saved worker host does not match the configured host.');
  }
  if (await deps.host.isAlive(priorRef as unknown as HostRef)) throw new ResumeError('The previous worker host is still active. Stop it before continuing.');
  const current = deps.db.getRun(row.id);
  if (!current || current.status !== 'failed' || current.attempt !== row.attempt || current.taskJson !== row.taskJson) {
    throw new ResumeError('The voyage changed while its checkpoint was being verified.');
  }
  const adapter = prePrAdapter(checkpoint.writerId === 'codex' ? codexAdapter : claudeCodeAdapter, resolve(deps.runsDir), checkpoint.settings);
  const command = adapter.buildCommand(checkpoint.task);
  const archive = join(resolve(deps.runsDir), `${row.id}.attempt-${row.attempt}-${randomUUID()}`);
  await mkdir(archive, { mode: 0o700 });
  await copyFile(checkpoint.specPath, join(archive, 'spec.json'), constants.COPYFILE_EXCL);
  await rename(checkpoint.exitPath, join(archive, 'exit'));
  let ref: HostRef | undefined;
  try {
    if (deps.isStopped?.()) throw new ResumeError('Continuation was cancelled before launch.');
    deps.db.updateRun(row.id, { status: 'running', endedAt: null, attempt: row.attempt + 1,
      taskJson: JSON.stringify(checkpoint.task), hostKind: null, hostRef: null });
    ref = await deps.host.launch({ runId: row.id, ...command, cwd: checkpoint.cwd,
      logPath: checkpoint.logPath, exitPath: checkpoint.exitPath, specPath: checkpoint.specPath });
    deps.db.updateRun(row.id, { hostKind: ref.kind, hostRef: JSON.stringify(ref) });
    deps.db.appendEvent(row.id, 'phase', `Continuing preserved revision ${checkpoint.task.prePrResume?.headSha} from review round ${checkpoint.task.prePrResume?.round}; original implementation and history retained.`, deps.now());
    const resumed = deps.db.getRun(row.id);
    if (!resumed) throw new Error('The resumed voyage could not be read.');
    return resumed;
  } catch (error) {
    if (ref) await deps.host.stop(ref);
    await rm(checkpoint.exitPath, { force: true });
    await copyFile(join(archive, 'spec.json'), checkpoint.specPath);
    await rename(join(archive, 'exit'), checkpoint.exitPath);
    deps.db.updateRun(row.id, row);
    throw error instanceof ResumeError ? error : new ResumeError('The continuation worker could not start; the failed voyage was preserved.');
  }
}
