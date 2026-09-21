import type { AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { RunResources } from './process-manager';
import type { LaunchIntent } from './retry';

export function launchResources(runId: string, intent: LaunchIntent, task?: Partial<AgentTask> | null): RunResources {
  if (task ? task.review && task.prHeadSha : intent.mode === 'review') return {};
  const ticketId = task?.todoId ?? intent.todoId ?? task?.ticketId ?? intent.ticketId;
  const prNumber = task?.prNumber ?? (intent.mode === 'rerun' ? intent.prNumber : undefined);
  const branch = task?.prBranch ?? (intent.mode === 'rerun' ? undefined : `agent/${runId}`);
  return {
    ...(typeof ticketId === 'string' && /^(?:[a-z][a-z\d_]*-[1-9]\d*)$/i.test(ticketId) ? { ticketId } : {}),
    ...(branch ? { branch } : {}),
    ...(Number.isSafeInteger(prNumber) && Number(prNumber) > 0 ? { prNumber } : {}),
  };
}

export function restoredResources(row: RunRow): RunResources {
  let task: Partial<AgentTask> | null = null;
  try {
    const value: unknown = JSON.parse(row.taskJson ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) task = value as Partial<AgentTask>;
  } catch {}
  return launchResources(row.id, { repo: row.repo, ticketId: row.ticketId }, {
    ...task, prNumber: task?.prNumber ?? row.prNumber ?? undefined,
  });
}
