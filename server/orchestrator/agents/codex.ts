import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
import { buildPrompt } from './prompt';
import { parsePrNumber } from './claude-stream';
import { validModel } from '../../../src/logic/agentOptions';

const DEFAULT_MODEL: string = 'astra';
const DEFAULT_EFFORT: string = 'medium';
const CODEX_EFFORTS: Set<string> = new Set(['minimal', 'low', 'medium', 'high']);

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
    buildPrompt(task),
  ];
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
    const child: ChildProcess = spawn('codex', codexArgs(task), { cwd: workdir, env: agentEnv });

    let prNumber: number | undefined;

    if (child.stdout) {
      const rl: Interface = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const parsed: number | undefined = parsePrNumber(line);
        if (parsed !== undefined) prNumber = parsed;
        onEvent({ kind: 'log', text: line });
      });
    }
    if (child.stderr) {
      const rl: Interface = createInterface({ input: child.stderr });
      rl.on('line', (line: string) => onEvent({ kind: 'log', text: line }));
    }

    const exit: Promise<AgentResult> = new Promise((resolve) => {
      child.on('close', (code: number | null) => resolve({ ok: code === 0, prNumber }));
      child.on('error', (err: Error) => {
        onEvent({ kind: 'error', text: err.message });
        resolve({ ok: false, prNumber });
      });
    });

    return { stop: () => child.kill('SIGTERM'), exit };
  },
};
