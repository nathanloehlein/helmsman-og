import type { Db, RunRow, RunStatus } from './db';
import type { RunBus } from './event-bus';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './agents/adapter';

export interface RunnerDeps {
  db: Db;
  bus: RunBus;
  adapter: AgentAdapter;
  createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>;
  createWorktreeFromBranch?: (repo: string, runId: string, branch: string) => Promise<{ path: string; branch: string }>;
  removeWorktree: (repo: string, path: string) => Promise<void>;
  now: () => string;
  genId: () => string;
  onStart?: (handle: AgentHandle) => void;
  jira?: JiraActions | null;
  botAccountId?: string;
  statusInProgress?: string;
  statusInReview?: string;
  findPrNumber?: (repo: string, branch: string) => Promise<number | null>;
  maxAttempts?: number;
  maxCostUsd?: number | null;
  isStopped?: () => boolean;
}

async function claimTicket(
  jira: JiraActions,
  ticketId: string,
  accountId: string,
  statusInProgress: string,
  onEvent: (e: AgentEvent) => void,
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
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  try {
    await jira.transition(ticketId, statusInReview);
    onEvent({ kind: 'log', text: `transitioned ticket ${ticketId} to ${statusInReview}` });
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    onEvent({ kind: 'log', text: `jira transition failed (non-fatal): ${text}` });
  }
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
  const maxAttempts: number = Math.max(1, deps.maxAttempts ?? 1);
  const statusInProgress: string = deps.statusInProgress ?? 'In Progress';
  const statusInReview: string = deps.statusInReview ?? 'In Review';
  const initial: RunRow = {
    id: runId, ticketId: task.ticketId, repo: task.repo, adapter: deps.adapter.id,
    status: 'running', attempt: 1, prNumber: null, startedAt: deps.now(),
    endedAt: null, costUsd: null, worktreePath: null,
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

    const onEvent = (e: AgentEvent): void => {
      deps.db.appendEvent(runId, e.kind, e.text, deps.now());
      deps.bus.publish(runId, e);
    };

    if (deps.jira && deps.botAccountId && !task.task) {
      await claimTicket(deps.jira, task.ticketId, deps.botAccountId, statusInProgress, onEvent);
    }

    let result: AgentResult = { ok: false };
    let totalCost: number | null = null;
    let stopped: boolean = false;
    for (let attempt: number = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        deps.db.updateRun(runId, { attempt });
        onEvent({ kind: 'log', text: `retry ${attempt}/${maxAttempts}` });
      }
      const handle: AgentHandle = deps.adapter.start(task, worktree.path, onEvent);
      deps.onStart?.(handle);
      result = await handle.exit;
      if (result.costUsd != null) totalCost = (totalCost ?? 0) + result.costUsd;
      if (result.ok) break;
      if (deps.isStopped?.()) {
        stopped = true;
        onEvent({ kind: 'log', text: 'run stopped, no further attempts' });
        break;
      }
      if (deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd) {
        onEvent({ kind: 'log', text: 'cost cap reached, no further attempts' });
        break;
      }
    }

    let prNumber: number | null = task.prNumber ?? result.prNumber ?? null;
    if (prNumber == null && result.ok && deps.findPrNumber) {
      try {
        prNumber = await deps.findPrNumber(task.repo, worktree.branch);
      } catch (err) {
        const text: string = err instanceof Error ? err.message : String(err);
        onEvent({ kind: 'log', text: `find PR failed (non-fatal): ${text}` });
      }
    }

    const status: RunStatus = stopped ? 'stopped' : result.ok ? 'succeeded' : 'failed';
    deps.db.updateRun(runId, {
      status,
      prNumber,
      costUsd: totalCost,
      endedAt: deps.now(),
    });

    if (result.ok && deps.jira && prNumber != null && !task.task) {
      await markInReview(deps.jira, task.ticketId, statusInReview, onEvent);
    }
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    deps.db.appendEvent(runId, 'error', text, deps.now());
    deps.bus.publish(runId, { kind: 'error', text });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } finally {
    if (worktreePath) await deps.removeWorktree(task.repo, worktreePath);
    const finalRow: RunRow | null = deps.db.getRun(runId);
    const finalStatus: string = finalRow?.status ?? 'failed';
    deps.db.appendEvent(runId, 'run-complete', finalStatus, deps.now());
    deps.bus.publish(runId, { kind: 'run-complete', text: finalStatus });
  }
  return runId;
}
