import type { AgentAdapter, AgentEvent, AgentTask } from './adapter';
import { buildPrompt } from './prompt';
import { parsePrNumber } from './claude-stream';
import { validModel } from '../../../src/logic/agentOptions';

const DEFAULT_MODEL: string = 'gpt-6-astra';
const DEFAULT_EFFORT: string = 'medium';
const CODEX_EFFORTS: Set<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function validCodexEffort(effort: string | undefined | null): string | null {
  return effort && CODEX_EFFORTS.has(effort) ? effort : null;
}

export function codexArgs(task: AgentTask): string[] {
  const model: string = validModel(task.model) ?? DEFAULT_MODEL;
  const effort: string = validCodexEffort(task.effort) ?? DEFAULT_EFFORT;
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    ...(task.review ? ['-c', 'features.multi_agent=true'] : []),
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
