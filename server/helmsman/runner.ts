import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, RunRow, RunStatus } from './db';
import type { RunBus } from './event-bus';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentTask } from './agents/adapter';
import { tailLog, readLogLines, type LogLineConsumer, type Tail } from './log-tail';
import type { HostRef, RunHost } from './run-host';
import { reviewVerdictLine } from './review-verdict';
import { parseInlineReviewComments, type InlineReviewInput } from './inline-review';
import { agentAttribution } from './agent-attribution';

export interface RunnerDeps {
  db: Db;
  recordAgentEvent?: (run: RunRow, task: AgentTask, event: AgentEvent, byteOffset: number) => number | null;
  pollClarifications?: (runId: string) => void;
  hasRequiredUnanswered?: (runId: string) => boolean;
  onRunComplete?: (run: RunRow) => void;
  bus: RunBus;
  adapter: AgentAdapter;
  host: RunHost;
  runsDir: string;
  launchJson?: string;
  createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>;
  createWorktreeFromBranch?: (repo: string, runId: string, branch: string) => Promise<{ path: string; branch: string }>;
  createReviewWorktree?: (repo: string, runId: string, prNumber: number, headSha: string) => Promise<{ path: string; branch: string }>;
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
  preserveWorktreeOnFailure?: boolean;
  isStopped?: () => boolean;
  readReview?: (worktreePath: string) => Promise<string | null>;
  readReviewComments?: (worktreePath: string) => Promise<string | null>;
  postReview?: (repo: string, prNumber: number, body: string, input: InlineReviewInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  requestCopilotReview?: (repo: string, prNumber: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  enqueueCreatedPrReview?: (input: { parentRunId: string; repo: string; prNumber: number }) => void;
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
  runId: string,
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
  const comments = parseInlineReviewComments(await deps.readReviewComments?.(worktreePath) ?? null);
  if (deps.isStopped?.()) return 'stopped';
  deps.pollClarifications?.(runId);
  if (deps.hasRequiredUnanswered?.(runId)) {
    onEvent({ kind: 'error', text: 'Required clarification has no answer; review publication blocked', stage: 'clarification' });
    return 'failed';
  }
  const r = await deps.postReview(task.repo, prNumber, body, {
    headSha: task.prHeadSha,
    comments,
    attribution: agentAttribution(deps.adapter.id, task, 'review agent'),
  });
  if (!r.ok) {
    onEvent({ kind: 'error', text: `code review failed: posting comment on PR #${prNumber} failed: ${r.error}` });
    return 'failed';
  }
  onEvent({ kind: 'log', text: `posted code-review comment on PR #${prNumber}` });
  onEvent({ kind: 'review-verdict', text: reviewVerdictLine(body) });
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


interface WaitForExitOptions {
  pollIntervalMs: number;
  isStopped: () => boolean;
  isCostCapped: () => boolean;
  poll?: () => void;
}

function waitForExit(exitPath: string, opts: WaitForExitOptions): Promise<number | 'stopped' | 'capped'> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      try { opts.poll?.(); } catch (error) { reject(error); return; }
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
  consume: LogLineConsumer,
  waitOpts: WaitForExitOptions,
): Promise<number | 'stopped' | 'capped'> {
  let tailError: unknown;
  const tail: Tail = tailLog(logPath, startOffset, consume, (off) => deps.db.updateRun(runId, { logOffset: off }), error => { tailError = error; });
  let outcome: number | 'stopped' | 'capped';
  try { outcome = await waitForExit(exitPath, { ...waitOpts, poll: () => deps.pollClarifications?.(runId), isStopped: () => tailError !== undefined || waitOpts.isStopped() }); } finally { tail.stop(); }
  if (tailError !== undefined) throw tailError;
  const logOffset = readLogLines(logPath, deps.db.getRun(runId)?.logOffset ?? startOffset, consume, true);
  deps.db.updateRun(runId, { logOffset });
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
  const { runId, task, deps, prNumber, totalCost, ok, worktreePath, onEvent } = p;
  if (ok && deps.hasRequiredUnanswered?.(runId)) {
    onEvent({ kind: 'error', text: 'Required clarification has no answer; task cannot complete', stage: 'clarification' });
    p.ok = false;
  }
  const stopped = p.stopped || (deps.isStopped?.() ?? false);
  const statusInReview: string = deps.statusInReview ?? 'In Review';
  const status: RunStatus = stopped ? 'stopped' : p.ok ? 'succeeded' : 'failed';

  if (task.review) {
    if (deps.hasRequiredUnanswered?.(runId)) {
      deps.db.updateRun(runId, { status: 'failed', prNumber, costUsd: totalCost, endedAt: deps.now() }); return;
    }
    const reviewStatus: RunStatus = await postReviewDerivingStatusFromReviewNotExitCode(runId, task, worktreePath, prNumber, stopped, deps, onEvent);
    deps.db.updateRun(runId, { status: reviewStatus, prNumber, costUsd: totalCost, endedAt: deps.now() });
    return;
  }

  const createdPr = status === 'succeeded' && prNumber != null && !task.prBranch;
  if (createdPr && deps.enqueueCreatedPrReview) {
    try {
      deps.enqueueCreatedPrReview({ parentRunId: runId, repo: task.repo, prNumber });
      onEvent({ kind: 'log', text: `Queued Helmsman review for PR #${prNumber}` });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      onEvent({ kind: 'error', text: `Queuing Helmsman review for PR #${prNumber} failed: ${text}` });
    }
  }

  deps.db.updateRun(runId, { status, prNumber, costUsd: totalCost, endedAt: deps.now() });

  if (createdPr && deps.jira && !task.todoId && !task.task) {
    await markInReview(deps.jira, task.ticketId, statusInReview, onEvent);
  }

  if (createdPr && task.modelRouting !== 'gocaas' && deps.requestCopilotReview) {
    try {
      const r: { ok: true } | { ok: false; error: string } = await deps.requestCopilotReview(task.repo, prNumber);
      if (r.ok) {
        onEvent({ kind: 'log', text: `requested Copilot review on PR #${prNumber}` });
      } else {
        onEvent({ kind: 'log', text: `requesting Copilot review failed (non-fatal): ${r.error}` });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      onEvent({ kind: 'log', text: `requesting Copilot review failed (non-fatal): ${text}` });
    }
  }
}

async function resolvePrNumber(
  repo: string,
  branch: string,
  prNumber: number | null,
  ok: boolean,
  deps: RunnerDeps,
  onEvent: OnEvent,
): Promise<number | null> {
  if (prNumber != null || !ok || !deps.findPrNumber) return prNumber;
  try {
    return await deps.findPrNumber(repo, branch);
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    onEvent({ kind: 'log', text: `find PR failed (non-fatal): ${text}` });
    return prNumber;
  }
}

async function completeRun(runId: string, repo: string, worktreePath: string | null, deps: RunnerDeps): Promise<void> {
  const finalRow: RunRow | null = deps.db.getRun(runId);
  const finalStatus: string = finalRow?.status ?? 'failed';
  if (finalRow) deps.onRunComplete?.(finalRow);
  if (worktreePath) {
    if (deps.preserveWorktreeOnFailure && finalStatus !== 'succeeded') {
      const text = `Worktree retained for inspection: ${worktreePath}`;
      deps.db.appendEvent(runId, 'phase', text, deps.now());
      deps.bus.publish(runId, { kind: 'phase', text });
    } else await deps.removeWorktree(repo, worktreePath);
  }
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
    status: 'running', attempt: 1, prNumber: task.prNumber ?? null, startedAt: deps.now(),
    endedAt: null, costUsd: null, worktreePath: null,
    logPath, exitPath, specPath, logOffset: 0, taskJson: JSON.stringify(task), launchJson: deps.launchJson ?? null,
  };
  deps.db.insertRun(initial);
  if (task.reviewComplexity) {
    const text = `Review complexity: ${task.reviewComplexity}; model: ${task.model ?? 'provider default'}; effort: ${task.effort ?? 'provider default'}. ${task.reviewReason ?? ''}`;
    deps.db.appendEvent(runId, 'phase', text, deps.now());
    deps.bus.publish(runId, { kind: 'phase', text });
  }
  let worktreePath: string | null = null;
  let runningHost: HostRef | null = null;
  try {
    const pinnedReview = task.review && task.prHeadSha;
    if (pinnedReview && (!deps.createReviewWorktree || !task.prNumber)) {
      throw new Error('pinned review requires createReviewWorktree and a PR number');
    }
    if (!pinnedReview && task.prBranch && !deps.createWorktreeFromBranch) {
      throw new Error('rerun requires createWorktreeFromBranch');
    }
    const worktree: { path: string; branch: string } = pinnedReview
      ? await deps.createReviewWorktree!(task.repo, runId, task.prNumber!, pinnedReview)
      : task.prBranch
        ? await deps.createWorktreeFromBranch!(task.repo, runId, task.prBranch)
        : await deps.createWorktree(task.repo, runId);
    worktreePath = worktree.path;
    deps.db.updateRun(runId, { worktreePath: worktree.path });

    const onEvent: OnEvent = (e) => {
      deps.db.appendEvent(runId, e.kind, e.text, deps.now());
      deps.bus.publish(runId, e);
    };

    if (deps.jira && deps.botAccountId && !task.todoId && !task.task && !task.prBranch) {
      await claimTicket(deps.jira, task.ticketId, deps.botAccountId, statusInProgress, onEvent);
    }

    let totalCost: number | null = null;
    let prNumber: number | null = task.prNumber ?? null;
    let stopped: boolean = false;
    let ok: boolean = false;

    const consume = (line: string, byteOffset: number): void => {
      const e: AgentEvent | null = deps.adapter.parseLine(line);
      if (!e) return;
      const current = deps.db.getRun(runId);
      if (deps.recordAgentEvent && current) {
        totalCost = deps.recordAgentEvent(current, task, e, byteOffset);
        deps.db.updateRun(runId, { costUsd: totalCost });
      } else if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd >= 0) {
        totalCost = (totalCost ?? 0) + e.costUsd;
        deps.db.updateRun(runId, { costUsd: totalCost });
      }
      if (e.prNumber != null) {
        prNumber = e.prNumber;
        deps.db.updateRun(runId, { prNumber });
      }
      onEvent(e);
    };

    for (let attempt: number = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        deps.db.updateRun(runId, { attempt, logOffset: 0 });
        onEvent({ kind: 'log', text: `retry ${attempt}/${maxAttempts}` });
      }

      const { cmd, args } = deps.adapter.buildCommand(task);
      let outcome: number | 'stopped' | 'capped' = 1;
      let ref: HostRef | null = null;
      if (cmd === '') {
        onEvent({ kind: 'error', text: 'adapter produced no command' });
      } else {
        resetAttemptFiles(logPath, exitPath);
        ref = await deps.host.launch({ runId, cmd, args, cwd: worktree.path, logPath, exitPath, specPath });
        runningHost = ref;
        deps.db.updateRun(runId, { hostKind: ref.kind, hostRef: JSON.stringify(ref) });
        deps.onLaunch?.(runId, () => deps.host.stop(ref!));
        outcome = await tailUntilExit(runId, logPath, exitPath, 0, deps, consume, {
          pollIntervalMs: deps.pollIntervalMs ?? 250,
          isStopped: () => deps.isStopped?.() ?? false,
          isCostCapped: () => deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd,
        });
      }

      if (typeof outcome === 'number') runningHost = null;
      ok = typeof outcome === 'number' && outcome === 0;
      if (ok) break;

      if (outcome === 'stopped' || deps.isStopped?.()) {
        stopped = true;
        onEvent({ kind: 'log', text: 'run stopped, no further attempts' });
        break;
      }
      if (outcome === 'capped' || (deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd)) {
        if (ref) await deps.host.stop(ref);
        onEvent({ kind: 'log', text: 'cost cap reached, no further attempts' });
        break;
      }
    }

    prNumber = await resolvePrNumber(task.repo, worktree.branch, prNumber, ok, deps, onEvent);

    await finalizeRun({ runId, task, deps, prNumber, totalCost, stopped, ok, worktreePath: worktree.path, onEvent });
  } catch (err) {
    if (runningHost) await deps.host.stop(runningHost).catch(() => {});
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
  const logPath: string = row.logPath ?? join(deps.runsDir, `${runId}.log`);
  const exitPath: string = row.exitPath ?? join(deps.runsDir, `${runId}.exit`);
  const worktreePath: string | null = row.worktreePath ?? null;

  const onEvent: OnEvent = (e) => {
    deps.db.appendEvent(runId, e.kind, e.text, deps.now());
    deps.bus.publish(runId, e);
  };

  try {
    const task: AgentTask = JSON.parse(row.taskJson ?? '{}') as AgentTask;
    let totalCost: number | null = row.costUsd ?? null;
    let prNumber: number | null = row.prNumber ?? null;

    const branch: string = task.prBranch ?? `agent/${runId}`;

    const consume = (line: string, byteOffset: number): void => {
      const e: AgentEvent | null = deps.adapter.parseLine(line);
      if (!e) return;
      const current = deps.db.getRun(runId);
      if (deps.recordAgentEvent && current) {
        totalCost = deps.recordAgentEvent(current, task, e, byteOffset);
        deps.db.updateRun(runId, { costUsd: totalCost });
      } else if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd >= 0) {
        totalCost = (totalCost ?? 0) + e.costUsd;
        deps.db.updateRun(runId, { costUsd: totalCost });
      }
      if (e.prNumber != null) {
        prNumber = e.prNumber;
        deps.db.updateRun(runId, { prNumber });
      }
      onEvent(e);
    };

    const existingCode: number | null = readExitCode(exitPath);
    if (existingCode != null) {
      deps.pollClarifications?.(runId);
      const logOffset = readLogLines(logPath, row.logOffset ?? 0, consume, true);
      deps.db.updateRun(runId, { logOffset });
      const ok: boolean = existingCode === 0;
      prNumber = await resolvePrNumber(row.repo, branch, prNumber, ok, deps, onEvent);
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
      if (outcome === 'capped') await deps.host.stop(ref);
      const ok: boolean = typeof outcome === 'number' && outcome === 0;
      const stopped: boolean = outcome === 'stopped' || (deps.isStopped?.() ?? false);
      prNumber = await resolvePrNumber(row.repo, branch, prNumber, ok, deps, onEvent);
      await finalizeRun({ runId, task, deps, prNumber, totalCost, stopped, ok, worktreePath: worktreePath ?? '', onEvent });
      return;
    }

    onEvent({ kind: 'error', text: 'run interrupted: host gone' });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } catch (err) {
    if (row.hostRef) {
      try { await deps.host.stop(JSON.parse(row.hostRef) as HostRef); } catch {}
    }
    const text: string = err instanceof Error ? err.message : String(err);
    deps.db.appendEvent(runId, 'error', text, deps.now());
    deps.bus.publish(runId, { kind: 'error', text });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } finally {
    await completeRun(runId, row.repo, worktreePath, deps);
  }
}
