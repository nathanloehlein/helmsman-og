import { describe, expect, it } from 'vitest';
import type { AgentTask } from './adapter';
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

  it('drops empty tokens produced by a whitespace-padded substitution', () => {
    const task: AgentTask = { ticketId: 'ABC-1', repo: 'o/r', title: ' Fix bug ', jiraBaseUrl: '' };
    const argv: string[] = buildArgv('run --title {title}', task);
    expect(argv).toEqual(['run', '--title', 'Fix', 'bug']);
  });

  it('drops the placeholder token entirely when it substitutes to an empty string', () => {
    const task: AgentTask = { ticketId: 'ABC-1', repo: 'o/r', title: '', jiraBaseUrl: '' };
    const argv: string[] = buildArgv('run --title {title}', task);
    expect(argv).toEqual(['run', '--title']);
  });
});

describe('commandAdapter', () => {
  it('reports id "command"', () => {
    expect(commandAdapter('node -e 0').id).toBe('command');
  });

  it('buildCommand splits the templated argv into cmd + args', () => {
    const task: AgentTask = { ticketId: 'X-1', title: 't', repo: 'o/r', jiraBaseUrl: '' };
    const adapter = commandAdapter('node -e console.log("hello")');
    const { cmd, args } = adapter.buildCommand(task);
    expect(cmd).toBe('node');
    expect(args).toEqual(['-e', 'console.log("hello")']);
  });

  it('buildCommand resolves to an empty cmd for a blank template', () => {
    const task: AgentTask = { ticketId: 'X-1', title: 't', repo: 'o/r', jiraBaseUrl: '' };
    const adapter = commandAdapter('   ');
    const { cmd, args } = adapter.buildCommand(task);
    expect(cmd).toBe('');
    expect(args).toEqual([]);
  });

  it('parseLine extracts the last PR number from a pull/<n> or PR # line', () => {
    const adapter = commandAdapter('node -e 0');
    expect(adapter.parseLine('opened pull/42')).toEqual({ kind: 'log', text: 'opened pull/42', prNumber: 42 });
    expect(adapter.parseLine('see PR #7')).toEqual({ kind: 'log', text: 'see PR #7', prNumber: 7 });
  });

  it('parseLine returns a plain log event when there is no PR number', () => {
    const adapter = commandAdapter('node -e 0');
    expect(adapter.parseLine('hello')).toEqual({ kind: 'log', text: 'hello' });
  });
});
