import type { Db, RunRow } from './db';
import type { RunBus } from './event-bus';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './agents/adapter';

export interface RunnerDeps {
  db: Db;
  bus: RunBus;
  adapter: AgentAdapter;
  createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>;
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
    onEvent({ kind: 'error', text: `jira claim failed: ${text}` });
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
    onEvent({ kind: 'error', text: `jira transition failed: ${text}` });
  }
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
  const maxAttempts: number = deps.maxAttempts ?? 1;
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
    const worktree: { path: string; branch: string } = await deps.createWorktree(task.repo, runId);
    worktreePath = worktree.path;
    deps.db.updateRun(runId, { worktreePath: worktree.path });

    const onEvent = (e: AgentEvent): void => {
      deps.db.appendEvent(runId, e.kind, e.text, deps.now());
      deps.bus.publish(runId, e);
    };

    if (deps.jira && deps.botAccountId) {
      await claimTicket(deps.jira, task.ticketId, deps.botAccountId, statusInProgress, onEvent);
    }

    let result: AgentResult = { ok: false };
    for (let attempt: number = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        deps.db.updateRun(runId, { attempt });
        onEvent({ kind: 'log', text: `retry ${attempt}/${maxAttempts}` });
      }
      const handle: AgentHandle = deps.adapter.start(task, worktree.path, onEvent);
      deps.onStart?.(handle);
      result = await handle.exit;
      if (result.ok) break;
    }

    let prNumber: number | null = result.prNumber ?? null;
    if (result.ok && deps.findPrNumber) {
      try {
        prNumber = await deps.findPrNumber(task.repo, worktree.branch);
      } catch (err) {
        const text: string = err instanceof Error ? err.message : String(err);
        onEvent({ kind: 'error', text: `find PR failed: ${text}` });
      }
    }

    deps.db.updateRun(runId, {
      status: result.ok ? 'succeeded' : 'failed',
      prNumber,
      costUsd: result.costUsd ?? null,
      endedAt: deps.now(),
    });

    if (result.ok && deps.jira && prNumber != null) {
      await markInReview(deps.jira, task.ticketId, statusInReview, onEvent);
    }
  } catch (err) {
    const text: string = err instanceof Error ? err.message : String(err);
    deps.db.appendEvent(runId, 'error', text, deps.now());
    deps.bus.publish(runId, { kind: 'error', text });
    deps.db.updateRun(runId, { status: 'failed', endedAt: deps.now() });
  } finally {
    if (worktreePath) await deps.removeWorktree(task.repo, worktreePath);
  }
  return runId;
}
