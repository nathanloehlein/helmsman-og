import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
import { mapStreamLine } from './claude-stream';

export function buildPrompt(task: AgentTask): string {
  if (task.prBranch && task.prNumber) {
    return [
      `You are updating open pull request #${task.prNumber} on the current branch (${task.prBranch}).`,
      `The repository checkout is your current working directory.`,
      `You are running fully unattended: there is no human to ask, so never pause for confirmation or approval — carry out every step yourself.`,
      `Address this review feedback: ${task.task}.`,
      `Run the tests, commit, and push to the same branch, and do NOT open a new pull request and do NOT merge.`,
    ].join(' ');
  }
  const openPr: string =
    task.task && task.task.length > 0
      ? `Task: ${task.task}.`
      : `Work Jira ticket ${task.ticketId}: ${task.title}.`;
  const pushAndOpenPr: string =
    task.task && task.task.length > 0
      ? `Explore, implement the change, run the tests, commit on a new branch, then push it and open a pull request using the gh CLI.`
      : `Explore, implement the change, run the tests, commit on a new branch, then push it and open a pull request with the ticket id in the title using the gh CLI.`;
  return [
    openPr,
    `The repository checkout is your current working directory.`,
    `You are running fully unattended: there is no human to ask, so never pause for confirmation or approval — carry out every step yourself.`,
    pushAndOpenPr,
    `Pushing the branch and opening the PR are required steps, not optional — do them without asking.`,
    `Do NOT merge the PR. Stop only after the PR is open.`,
  ].join(' ');
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
    const child: ChildProcess = spawn(
      'claude',
      ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
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
