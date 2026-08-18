import type { Db, RunRow } from './db';
import type { RunBus } from './event-bus';
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
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
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

    const handle: AgentHandle = deps.adapter.start(task, worktree.path, onEvent);
    deps.onStart?.(handle);
    const result: AgentResult = await handle.exit;

    deps.db.updateRun(runId, {
      status: result.ok ? 'succeeded' : 'failed',
      prNumber: result.prNumber ?? null,
      costUsd: result.costUsd ?? null,
      endedAt: deps.now(),
    });
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
