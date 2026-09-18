import type { AgentAdapter, AgentEvent, AgentTask } from './adapter';

export function buildArgv(template: string, task: AgentTask): string[] {
  const tokens: string[] = template.trim().split(/\s+/);
  return tokens
    .flatMap((token: string): string[] =>
      token
        .replaceAll('{ticket}', task.ticketId)
        .replaceAll('{repo}', task.repo)
        .replaceAll('{title}', task.title)
        .split(/\s+/),
    )
    .filter((token: string): boolean => token.length > 0);
}

export function commandAdapter(template: string): AgentAdapter {
  return {
    id: 'command',
    buildCommand(task: AgentTask): { cmd: string; args: string[] } {
      const argv: string[] = buildArgv(template, task);
      const [cmd, ...args]: string[] = argv;
      return { cmd: cmd ?? '', args };
    },
    parseLine(line: string): AgentEvent | null {
      const m: RegExpMatchArray | null = line.match(/(?:pull\/|PR[ #]*)(\d+)/i);
      return m ? { kind: 'log', text: line, prNumber: Number(m[1]) } : { kind: 'log', text: line };
    },
  };
}
