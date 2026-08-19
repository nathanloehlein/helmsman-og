import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentResult, AgentTask } from './adapter';
import { buildArgv, commandAdapter } from './command';

describe('buildArgv', () => {
  it('splits the template on whitespace and substitutes placeholders per token', () => {
    const task: AgentTask = { ticketId: 'ABC-1', repo: 'o/r', title: 'Fix bug', jiraBaseUrl: '' };
    const argv: string[] = buildArgv('run --ticket {ticket} --repo {repo} --title {title}', task);
    expect(argv).toEqual(['run', '--ticket', 'ABC-1', '--repo', 'o/r', '--title', 'Fix', 'bug']);
  });

  it('never concatenates a metachar-bearing title into a single shell string', () => {
    const task: AgentTask = { ticketId: 'ABC-1', repo: 'o/r', title: 'a; rm -rf /', jiraBaseUrl: '' };
    const argv: string[] = buildArgv('run --title {title}', task);
    expect(argv).toEqual(['run', '--title', 'a;', 'rm', '-rf', '/']);
  });
});

describe('commandAdapter', () => {
  it('spawns the templated command without a shell, streams log events, and captures the last PR number', async () => {
    const task: AgentTask = { ticketId: 'X-1', title: 't', repo: 'o/r', jiraBaseUrl: '' };
    const events: AgentEvent[] = [];
    const adapter = commandAdapter('node -e console.log("hello");console.log("pull/42")');
    const handle = adapter.start(task, process.cwd(), (e: AgentEvent) => events.push(e));
    const result: AgentResult = await handle.exit;

    expect(result.ok).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(events.some((e: AgentEvent) => e.kind === 'log' && e.text.includes('hello'))).toBe(true);
  });

  it('reports id "command"', () => {
    expect(commandAdapter('node -e 0').id).toBe('command');
  });
});
