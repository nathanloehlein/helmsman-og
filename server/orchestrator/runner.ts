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
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
  const worktree: { path: string; branch: string } = await deps.createWorktree(task.repo, runId);

  const row: RunRow = {
    id: runId, ticketId: task.ticketId, repo: task.repo, adapter: deps.adapter.id,
    status: 'running', attempt: 1, prNumber: null, startedAt: deps.now(),
    endedAt: null, costUsd: null, worktreePath: worktree.path,
  };
  deps.db.insertRun(row);

  const onEvent = (e: AgentEvent): void => {
    deps.db.appendEvent(runId, e.kind, e.text, deps.now());
    deps.bus.publish(runId, e);
  };

  const handle: AgentHandle = deps.adapter.start(task, worktree.path, onEvent);
  const result: AgentResult = await handle.exit;

  deps.db.updateRun(runId, {
    status: result.ok ? 'succeeded' : 'failed',
    prNumber: result.prNumber ?? null,
    costUsd: result.costUsd ?? null,
    endedAt: deps.now(),
  });
  await deps.removeWorktree(task.repo, worktree.path);
  return runId;
}
