import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';

export function buildArgv(template: string, task: AgentTask): string[] {
  const tokens: string[] = template.trim().split(/\s+/);
  return tokens.flatMap((token: string): string[] =>
    token
      .replaceAll('{ticket}', task.ticketId)
      .replaceAll('{repo}', task.repo)
      .replaceAll('{title}', task.title)
      .split(/\s+/),
  );
}

export function commandAdapter(template: string): AgentAdapter {
  return {
    id: 'command',
    start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
      const argv: string[] = buildArgv(template, task);
      const [cmd, ...args]: string[] = argv;
      const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
      const child: ChildProcess = spawn(cmd, args, { cwd: workdir, env: agentEnv });

      let prNumber: number | undefined;

      if (child.stdout) {
        const rl: Interface = createInterface({ input: child.stdout });
        rl.on('line', (line: string) => {
          const match: RegExpMatchArray | null = line.match(/(?:pull\/|PR[ #]*)(\d+)/i);
          if (match) prNumber = Number(match[1]);
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
}
