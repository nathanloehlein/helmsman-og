import type { RunRow } from '../db';
import type { AgentAdapter, AgentTask } from './adapter';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { commandAdapter } from './command';
import { dockerReviewAdapter } from './docker-review';
import { isPrePrAdapter, prePrAdapter } from './pre-pr';

export function restoreRunAdapter(row: Pick<RunRow, 'adapter' | 'taskJson'>, options: { runsDir: string; agentCmd?: string | null }): AgentAdapter {
  if (isPrePrAdapter(row.adapter)) return prePrAdapter(row.adapter === 'pre-pr:claude-code' ? claudeCodeAdapter : codexAdapter, options.runsDir);
  if (row.adapter === 'command') return commandAdapter(options.agentCmd ?? '');
  const provider = row.adapter === 'claude-code' ? claudeCodeAdapter : codexAdapter;
  let value: unknown;
  try { value = row.taskJson ? JSON.parse(row.taskJson) : null; }
  catch { return provider; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return provider;
  const task = value as Partial<AgentTask>;
  if (task.review === true && task.dockerExecution && typeof task.dockerExecution === 'object' && !Array.isArray(task.dockerExecution)) {
    return dockerReviewAdapter(provider);
  }
  return provider;
}
