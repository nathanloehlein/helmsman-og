import type { AgentAdapter, AgentEvent, AgentTask } from './adapter';
import { buildPrompt } from './prompt';
import { parsePrNumber } from './claude-stream';
import { codexSettings } from '../agent-attribution';
export { validCodexEffort } from '../agent-attribution';

export function codexArgs(task: AgentTask): string[] {
  const { model, effort } = codexSettings(task);
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    ...(task.review || task.prePr?.stage === 'review' ? ['-c', 'features.multi_agent=true'] : []),
    buildPrompt(task, 'codex'),
  ];
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  buildCommand(task: AgentTask): { cmd: string; args: string[] } {
    return { cmd: 'codex', args: codexArgs(task) };
  },
  parseLine(line: string): AgentEvent | null {
    if (!line) return null;
    const prNumber: number | undefined = parsePrNumber(line);
    return prNumber !== undefined ? { kind: 'log', text: line, prNumber } : { kind: 'log', text: line };
  },
};
