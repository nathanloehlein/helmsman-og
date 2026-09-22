import type { AgentAdapter, AgentEvent, AgentTask } from './adapter';
import { buildPrompt } from './prompt';
import { parsePrNumber } from './claude-stream';
import { parseCodexStreamLine } from './codex-stream';
import { codexSettings } from '../agent-attribution';
import { routeAgentCommand } from '../gocaas';
export { validCodexEffort } from '../agent-attribution';

export function codexArgs(task: AgentTask): string[] {
  const { model, effort } = codexSettings(task);
  return [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    ...((task.review || task.prePr?.stage === 'review') && !task.prePr?.summaryCorrection ? ['-c', 'features.multi_agent=true'] : []),
    buildPrompt(task, 'codex'),
  ];
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  buildCommand(task: AgentTask): { cmd: string; args: string[] } {
    return routeAgentCommand(task, 'codex', { cmd: 'codex', args: codexArgs(task) });
  },
  parseLine(line: string): AgentEvent | null {
    if (!line) return null;
    const event = parseCodexStreamLine(line);
    if (event) {
      const prNumber: number | undefined = parsePrNumber(event.text);
      return prNumber === undefined ? event : { ...event, prNumber };
    }
    const prNumber: number | undefined = parsePrNumber(line);
    return prNumber !== undefined ? { kind: 'log', text: line, prNumber } : { kind: 'log', text: line };
  },
};
