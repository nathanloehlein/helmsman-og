import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
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
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
    const child: ChildProcess = spawn(
      'claude',
      ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...agentFlags(task)],
      { cwd: workdir, env: agentEnv },
    );

    let prNumber: number | undefined;
    let costUsd: number | undefined;

    if (child.stdout) {
      const rl: Interface = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const ev: AgentEvent | null = mapStreamLine(line);
        if (!ev) return;
        if (ev.costUsd !== undefined) costUsd = ev.costUsd;
        if (ev.prNumber !== undefined) prNumber = ev.prNumber;
        onEvent(ev);
      });
    }
    if (child.stderr) {
      const rl: Interface = createInterface({ input: child.stderr });
      rl.on('line', (line: string) => onEvent({ kind: 'log', text: line }));
    }

    const exit: Promise<AgentResult> = new Promise((resolve) => {
      child.on('close', (code: number | null) => resolve({ ok: code === 0, prNumber, costUsd }));
      child.on('error', (err: Error) => {
        onEvent({ kind: 'error', text: err.message });
        resolve({ ok: false, prNumber, costUsd });
      });
    });

    return { stop: () => child.kill('SIGTERM'), exit };
  },
};
