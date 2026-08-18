import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
import { mapStreamLine } from './claude-stream';

function buildPrompt(task: AgentTask): string {
  return [
    `Work Jira ticket ${task.ticketId}: ${task.title}.`,
    `The repository checkout is your current working directory.`,
    `Explore, implement the change, run the tests, then open a pull request with the ticket id in the title.`,
    `Do NOT merge. Stop after the PR is open.`,
  ].join(' ');
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const child: ChildProcess = spawn(
      'claude',
      ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose'],
      { cwd: workdir, env: process.env },
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
