import { describe, expect, it } from 'vitest';
import { codexArgs, validCodexEffort, codexAdapter } from './codex';
import type { AgentTask } from './adapter';

function task(over: Partial<AgentTask> = {}): AgentTask {
  return { ticketId: 'AB-1', title: 't', repo: 'o/r', jiraBaseUrl: '', ...over };
}

describe('validCodexEffort', () => {
  it('accepts codex efforts', () => {
    for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(validCodexEffort(e)).toBe(e);
  });
  it('rejects non-codex efforts and blanks', () => {
    for (const e of ['turbo', 'high; exit', '', null, undefined]) expect(validCodexEffort(e)).toBeNull();
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
    expect(args.at(-1)).toContain('requests only Copilot after the PR is created');
    expect(args.at(-1)).toContain('Do not request code owners, teams, or other human reviewers');
  });
  it('honors a provided model and effort', () => {
    const args = codexArgs(task({ model: 'opus', effort: 'high' }));
    expect(args[args.indexOf('-m') + 1]).toBe('opus');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });
  it('clamps an unsupported effort to medium', () => {
    const args = codexArgs(task({ effort: 'turbo' }));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
  });
  it('falls back to astra for a blank model', () => {
    expect(codexArgs(task({ model: '' })) [codexArgs(task({ model: '' })).indexOf('-m') + 1]).toBe('gpt-6-astra');
  });

  it.each(['xhigh', 'max'])('preserves an explicit %s effort in the CLI command', (effort) => {
    const args = codexArgs(task({ model: 'gpt-6-astra', effort }));
    expect(args[args.indexOf('-c') + 1]).toBe(`model_reasoning_effort="${effort}"`);
  });

  it.each(['feature', undefined])('instructs pinned reviews to retain their revision with branch %s', (prBranch) => {
    const sha = 'a'.repeat(40);
    const args = codexArgs(task({ review: true, prBranch, prNumber: 42, prHeadSha: sha }));
    expect(args.at(-1)).toContain(`Review the pinned revision ${sha}`);
    expect(args.at(-1)).toContain('Do not check out or switch to another revision');
    expect(args.at(-1)).not.toContain('Pushing the branch and opening the PR are required');
    expect(args).toContain('features.multi_agent=true');
    expect(args.at(-1)).toContain('Use $review-agent');
    expect(args.at(-1)).toContain('keep them as leaf reviewers');
    expect(args.at(-1)).toContain('materiality rules');
    expect(args.at(-1)).toContain('if there are no new inline findings');
    expect(args.at(-1)).toContain('report that limitation and use COMMENT');
    expect(args.at(-1)).toContain('Helmsman publishes');
  });

  it('does not enable review delegation or its skill for coding and feedback runs', () => {
    for (const input of [task(), task({ prBranch: 'feature', prNumber: 42, task: 'Fix the reported failure' })]) {
      const args = codexArgs(input);
      expect(args).not.toContain('features.multi_agent=true');
      expect(args.at(-1)).not.toContain('$review-agent');
    }
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
