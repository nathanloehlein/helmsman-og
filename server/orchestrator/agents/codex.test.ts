import { describe, expect, it } from 'vitest';
import { codexArgs, validCodexEffort, codexAdapter } from './codex';
import type { AgentTask } from './adapter';

function task(over: Partial<AgentTask> = {}): AgentTask {
  return { ticketId: 'AB-1', title: 't', repo: 'o/r', jiraBaseUrl: '', ...over };
}

describe('validCodexEffort', () => {
  it('accepts codex efforts', () => {
    for (const e of ['minimal', 'low', 'medium', 'high']) expect(validCodexEffort(e)).toBe(e);
  });
  it('rejects non-codex efforts and blanks', () => {
    for (const e of ['xhigh', 'max', '', null, undefined]) expect(validCodexEffort(e)).toBeNull();
  });
});

describe('codexArgs', () => {
  it('defaults to exec, bypass, astra, medium, prompt last', () => {
    const args = codexArgs(task());
    expect(args[0]).toBe('exec');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-astra');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(args[args.length - 1]).toContain('AB-1'); // prompt is last, references the ticket
  });
  it('honors a provided model and effort', () => {
    const args = codexArgs(task({ model: 'opus', effort: 'high' }));
    expect(args[args.indexOf('-m') + 1]).toBe('opus');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });
  it('clamps an unsupported effort to medium', () => {
    const args = codexArgs(task({ effort: 'max' }));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
  });
  it('falls back to astra for a blank model', () => {
    expect(codexArgs(task({ model: '' })) [codexArgs(task({ model: '' })).indexOf('-m') + 1]).toBe('gpt-6-astra');
  });
});

describe('codexAdapter', () => {
  it('has id codex', () => {
    expect(codexAdapter.id).toBe('codex');
  });

  it('buildCommand runs codex with codexArgs', () => {
    const { cmd, args } = codexAdapter.buildCommand(task());
    expect(cmd).toBe('codex');
    expect(args).toEqual(codexArgs(task()));
  });

  it('parseLine extracts a PR number from a pull/<n> line', () => {
    const event = codexAdapter.parseLine('opened https://github.com/o/r/pull/7');
    expect(event).toEqual({ kind: 'log', text: 'opened https://github.com/o/r/pull/7', prNumber: 7 });
  });

  it('parseLine returns a plain log event when there is no PR number', () => {
    const event = codexAdapter.parseLine('just some output');
    expect(event).toEqual({ kind: 'log', text: 'just some output' });
  });

  it('parseLine returns null for a blank line', () => {
    expect(codexAdapter.parseLine('')).toBeNull();
  });
});
