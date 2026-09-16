import type { AgentAdapter, AgentEvent, AgentTask } from './adapter';
import { mapStreamLine } from './claude-stream';
import { buildPrompt } from './prompt';
import { validEffort, validModel } from '../../../src/logic/agentOptions';

export function agentFlags(task: AgentTask): string[] {
  const flags: string[] = [];
  const model: string | null = validModel(task.model);
  if (model) flags.push('--model', model);
  const effort: string | null = validEffort(task.effort);
  if (effort) flags.push('--effort', effort);
  return flags;
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  buildCommand(task: AgentTask): { cmd: string; args: string[] } {
    return {
      cmd: 'claude',
      args: ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...agentFlags(task)],
    };
  },
  parseLine(line: string): AgentEvent | null {
    return mapStreamLine(line);
  },
};
