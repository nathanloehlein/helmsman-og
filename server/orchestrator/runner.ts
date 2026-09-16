import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, RunRow, RunStatus } from './db';
import type { RunBus } from './event-bus';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentTask } from './agents/adapter';
import { tailLog, type Tail } from './log-tail';
import type { HostRef, RunHost } from './run-host';

export interface RunnerDeps {
  db: Db;
  bus: RunBus;
  adapter: AgentAdapter;
  host: RunHost;
  runsDir: string;
  createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>;
  createWorktreeFromBranch?: (repo: string, runId: string, branch: string) => Promise<{ path: string; branch: string }>;
  removeWorktree: (repo: string, path: string) => Promise<void>;
  now: () => string;
  genId: () => string;
  onLaunch?: (runId: string, stop: () => Promise<void>) => void;
  pollIntervalMs?: number;
  jira?: JiraActions | null;
  botAccountId?: string;
  statusInProgress?: string;
  statusInReview?: string;
  findPrNumber?: (repo: string, branch: string) => Promise<number | null>;
  maxAttempts?: number;
  maxCostUsd?: number | null;
  isStopped?: () => boolean;
  readReview?: (worktreePath: string) => Promise<string | null>;
  postReview?: (repo: string, prNumber: number, body: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  requestCopilotReview?: (repo: string, prNumber: number) => Promise<{ ok: true } | { ok: false; error: string }>;
}

type OnEvent = (e: AgentEvent) => void;

async function claimTicket(
  jira: JiraActions,
  ticketId: string,
  accountId: string,
  statusInProgress: string,
  onEvent: OnEvent,
): Promise<void> {
  try {
    await jira.assign(ticketId, accountId);
    await jira.transition(ticketId, statusInProgress);
    onEvent({ kind: 'log', text: `claimed ticket ${ticketId}: assigned bot and transitioned to ${statusInProgress}` });
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    onEvent({ kind: 'log', text: `jira claim failed (non-fatal): ${text}` });
  }
}

async function markInReview(
  jira: JiraActions,
  ticketId: string,
  statusInReview: string,
  onEvent: OnEvent,
): Promise<void> {
  try {
    await jira.transition(ticketId, statusInReview);
    onEvent({ kind: 'log', text: `transitioned ticket ${ticketId} to ${statusInReview}` });
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    onEvent({ kind: 'log', text: `jira transition failed (non-fatal): ${text}` });
  }
}

async function postReviewDerivingStatusFromReviewNotExitCode(
  task: AgentTask,
  worktreePath: string,
  prNumber: number | null,
  stopped: boolean,
  deps: RunnerDeps,
  onEvent: OnEvent,
): Promise<RunStatus> {
  if (stopped) return 'stopped';
  if (prNumber == null) {
    onEvent({ kind: 'error', text: 'code review: no PR number to post the review to' });
    return 'failed';
  }
  if (!deps.readReview || !deps.postReview) {
    onEvent({ kind: 'error', text: 'code review: review reading/posting not configured' });
    return 'failed';
  }
  const body: string | null = await deps.readReview(worktreePath);
  if (!body || !body.trim()) {
    onEvent({ kind: 'error', text: 'code review failed: agent produced no .agent-review.md — nothing to post' });
    return 'failed';
  }
  const r: { ok: true } | { ok: false; error: string } = await deps.postReview(task.repo, prNumber, body);
  if (!r.ok) {
    onEvent({ kind: 'error', text: `code review failed: posting comment on PR #${prNumber} failed: ${r.error}` });
    return 'failed';
  }
  onEvent({ kind: 'log', text: `posted code-review comment on PR #${prNumber}` });
  return 'succeeded';
}

function resetAttemptFiles(logPath: string, exitPath: string): void {
  for (const p of [logPath, exitPath]) {
    try {
      unlinkSync(p);
    } catch {
      void 0;
    }
  }
}

function readExitCode(exitPath: string): number | null {
  if (!existsSync(exitPath)) return null;
  const raw: string = readFileSync(exitPath, 'utf8').trim();
  const n: number = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function pumpRemaining(logPath: string, fromOffset: number, onLine: (line: string) => void): void {
  let offset: number = fromOffset;
  let fd: number | null = null;
  try {
    fd = openSync(logPath, 'r');
    const size: number = fstatSync(fd).size;
    if (size > offset) {
      const len: number = size - offset;
      const buf: Buffer = Buffer.alloc(len);
      const read: number = readSync(fd, buf, 0, len, offset);
      offset += read;
      let buffer: string = buf.subarray(0, read).toString('utf8');
      let nl: number = buffer.indexOf('\n');
      while (nl !== -1) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    }
  } catch {
    void 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface WaitForExitOptions {
  pollIntervalMs: number;
  isStopped: () => boolean;
  isCostCapped: () => boolean;
}

function waitForExit(exitPath: string, opts: WaitForExitOptions): Promise<number | 'stopped' | 'capped'> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const code: number | null = readExitCode(exitPath);
      if (code != null) {
        resolve(code);
        return;
      }
      if (opts.isStopped()) {
        resolve('stopped');
        return;
      }
      if (opts.isCostCapped()) {
        resolve('capped');
        return;
      }
      setTimeout(tick, opts.pollIntervalMs);
    };
    tick();
  });
}

async function tailUntilExit(
  runId: string,
  logPath: string,
  exitPath: string,
  startOffset: number,
  deps: RunnerDeps,
  consume: (line: string) => void,
  waitOpts: WaitForExitOptions,
): Promise<number | 'stopped' | 'capped'> {
  const tail: Tail = tailLog(logPath, startOffset, consume, (off) => deps.db.updateRun(runId, { logOffset: off }));
  const outcome: number | 'stopped' | 'capped' = await waitForExit(exitPath, waitOpts);
  pumpRemaining(logPath, deps.db.getRun(runId)?.logOffset ?? startOffset, consume);
  tail.stop();
  return outcome;
}

interface FinalizeParams {
  runId: string;
  task: AgentTask;
  deps: RunnerDeps;
  prNumber: number | null;
  totalCost: number | null;
  stopped: boolean;
  ok: boolean;
  worktreePath: string;
  onEvent: OnEvent;
}

async function finalizeRun(p: FinalizeParams): Promise<void> {
  const { runId, task, deps, prNumber, totalCost, stopped, ok, worktreePath, onEvent } = p;
  const statusInReview: string = deps.statusInReview ?? 'In Review';
  const status: RunStatus = stopped ? 'stopped' : ok ? 'succeeded' : 'failed';

  if (task.review) {
    const reviewStatus: RunStatus = await postReviewDerivingStatusFromReviewNotExitCode(task, worktreePath, prNumber, stopped, deps, onEvent);
    deps.db.updateRun(runId, { status: reviewStatus, prNumber, costUsd: totalCost, endedAt: deps.now() });
    return;
  }

  deps.db.updateRun(runId, { status, prNumber, costUsd: totalCost, endedAt: deps.now() });

  if (ok && deps.jira && prNumber != null && !task.task && !task.prBranch) {
    await markInReview(deps.jira, task.ticketId, statusInReview, onEvent);
  }

  if (ok && prNumber != null && !task.prBranch && deps.requestCopilotReview) {
    const r: { ok: true } | { ok: false; error: string } = await deps.requestCopilotReview(task.repo, prNumber);
    if (r.ok) {
      onEvent({ kind: 'log', text: `requested Copilot review on PR #${prNumber}` });
    } else {
      onEvent({ kind: 'log', text: `requesting Copilot review failed (non-fatal): ${r.error}` });
    }
  }
}

async function completeRun(runId: string, repo: string, worktreePath: string | null, deps: RunnerDeps): Promise<void> {
  if (worktreePath) await deps.removeWorktree(repo, worktreePath);
  const finalRow: RunRow | null = deps.db.getRun(runId);
  const finalStatus: string = finalRow?.status ?? 'failed';
  deps.db.appendEvent(runId, 'run-complete', finalStatus, deps.now());
  deps.bus.publish(runId, { kind: 'run-complete', text: finalStatus });
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
  const maxAttempts: number = Math.max(1, deps.maxAttempts ?? 1);
  const statusInProgress: string = deps.statusInProgress ?? 'In Progress';
  const logPath: string = join(deps.runsDir, `${runId}.log`);
  const exitPath: string = join(deps.runsDir, `${runId}.exit`);
  const specPath: string = join(deps.runsDir, `${runId}.json`);

  const initial: RunRow = {
    id: runId, ticketId: task.ticketId, repo: task.repo, adapter: deps.adapter.id,
    status: 'running', attempt: 1, prNumber: null, startedAt: deps.now(),
    endedAt: null, costUsd: null, worktreePath: null,
    logPath, exitPath, specPath, logOffset: 0, taskJson: JSON.stringify(task),
  };
  deps.db.insertRun(initial);
  let worktreePath: string | null = null;
  try {
    if (task.prBranch && !deps.createWorktreeFromBranch) {
      throw new Error('rerun requires createWorktreeFromBranch');
    }
    const worktree: { path: string; branch: string } = task.prBranch
      ? await deps.createWorktreeFromBranch!(task.repo, runId, task.prBranch)
      : await deps.createWorktree(task.repo, runId);
    worktreePath = worktree.path;
    deps.db.updateRun(runId, { worktreePath: worktree.path });

    const onEvent: OnEvent = (e) => {
      deps.db.appendEvent(runId, e.kind, e.text, deps.now());
      deps.bus.publish(runId, e);
    };

    if (deps.jira && deps.botAccountId && !task.task && !task.prBranch) {
      await claimTicket(deps.jira, task.ticketId, deps.botAccountId, statusInProgress, onEvent);
    }

    let totalCost: number | null = null;
    let prNumber: number | null = task.prNumber ?? null;
    let stopped: boolean = false;
    let ok: boolean = false;

    const consume = (line: string): void => {
      const e: AgentEvent | null = deps.adapter.parseLine(line);
      if (!e) return;
      if (e.costUsd != null) totalCost = (totalCost ?? 0) + e.costUsd;
      if (e.prNumber != null) prNumber = e.prNumber;
      onEvent(e);
    };

    for (let attempt: number = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        deps.db.updateRun(runId, { attempt, logOffset: 0 });
        onEvent({ kind: 'log', text: `retry ${attempt}/${maxAttempts}` });
      }

      const { cmd, args } = deps.adapter.buildCommand(task);
      let outcome: number | 'stopped' | 'capped' = 1;
      if (cmd === '') {
        onEvent({ kind: 'error', text: 'adapter produced no command' });
      } else {
        resetAttemptFiles(logPath, exitPath);
        const ref: HostRef = await deps.host.launch({ runId, cmd, args, cwd: worktree.path, logPath, exitPath, specPath });
        deps.db.updateRun(runId, { hostKind: ref.kind, hostRef: JSON.stringify(ref) });
        deps.onLaunch?.(runId, () => deps.host.stop(ref));
        outcome = await tailUntilExit(runId, logPath, exitPath, 0, deps, consume, {
          pollIntervalMs: deps.pollIntervalMs ?? 250,
          isStopped: () => deps.isStopped?.() ?? false,
          isCostCapped: () => deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd,
        });
      }

      ok = typeof outcome === 'number' && outcome === 0;
      if (ok) break;

      if (outcome === 'stopped' || deps.isStopped?.()) {
        stopped = true;
        onEvent({ kind: 'log', text: 'run stopped, no further attempts' });
        break;
      }
      if (outcome === 'capped' || (deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd)) {
        onEvent({ kind: 'log', text: 'cost cap reached, no further attempts' });
        break;
      }
    }

    if (prNumber == null && ok && deps.findPrNumber) {
      try {
        prNumber = await deps.findPrNumber(task.repo, worktree.branch);
      } catch (err) {
        const text: string = err instanceof Error ? err.message : String(err);
        onEvent({ kind: 'log', text: `find PR failed (non-fatal): ${text}` });
      }
    }

    await finalizeRun({ runId, task, deps, prNumber, totalCost, stopped, ok, worktreePath: worktree.path, onEvent });
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    deps.db.appendEvent(runId, 'error', text, deps.now());
    deps.bus.publish(runId, { kind: 'error', text });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } finally {
    await completeRun(runId, task.repo, worktreePath, deps);
  }
  return runId;
}

export async function reattachRun(row: RunRow, deps: RunnerDeps): Promise<void> {
  const runId: string = row.id;
  const task: AgentTask = JSON.parse(row.taskJson ?? '{}') as AgentTask;
  const logPath: string = row.logPath ?? join(deps.runsDir, `${runId}.log`);
  const exitPath: string = row.exitPath ?? join(deps.runsDir, `${runId}.exit`);
  const worktreePath: string | null = row.worktreePath ?? null;

  const onEvent: OnEvent = (e) => {
    deps.db.appendEvent(runId, e.kind, e.text, deps.now());
    deps.bus.publish(runId, e);
  };

  let totalCost: number | null = row.costUsd ?? null;
  let prNumber: number | null = row.prNumber ?? null;

  const consume = (line: string): void => {
    const e: AgentEvent | null = deps.adapter.parseLine(line);
    if (!e) return;
    if (e.costUsd != null) totalCost = (totalCost ?? 0) + e.costUsd;
    if (e.prNumber != null) prNumber = e.prNumber;
    onEvent(e);
  };

  try {
    const existingCode: number | null = readExitCode(exitPath);
    if (existingCode != null) {
      pumpRemaining(logPath, row.logOffset ?? 0, consume);
      const ok: boolean = existingCode === 0;
      await finalizeRun({ runId, task, deps, prNumber, totalCost, stopped: false, ok, worktreePath: worktreePath ?? '', onEvent });
      return;
    }

    const ref: HostRef | null = row.hostRef ? (JSON.parse(row.hostRef) as HostRef) : null;
    const alive: boolean = ref != null && (await deps.host.isAlive(ref));
    if (alive && ref != null) {
      deps.onLaunch?.(runId, () => deps.host.stop(ref));
      const outcome: number | 'stopped' | 'capped' = await tailUntilExit(runId, logPath, exitPath, row.logOffset ?? 0, deps, consume, {
        pollIntervalMs: deps.pollIntervalMs ?? 250,
        isStopped: () => deps.isStopped?.() ?? false,
        isCostCapped: () => deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd,
      });
      const ok: boolean = typeof outcome === 'number' && outcome === 0;
      const stopped: boolean = outcome === 'stopped';
      await finalizeRun({ runId, task, deps, prNumber, totalCost, stopped, ok, worktreePath: worktreePath ?? '', onEvent });
      return;
    }

    onEvent({ kind: 'error', text: 'run interrupted: host gone' });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } finally {
    await completeRun(runId, task.repo, worktreePath, deps);
  }
}
