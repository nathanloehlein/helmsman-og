import { describe, expect, it } from 'vitest';
import { agentFlags, claudeCodeAdapter } from './claude-code';
import { buildPrompt } from './prompt';
import type { AgentTask } from './adapter';

describe('agentFlags', () => {
  const base: AgentTask = { ticketId: 'T-1', title: 't', repo: 'o/r', jiraBaseUrl: '' };

  it('is empty when no model or effort is set', () => {
    expect(agentFlags(base)).toEqual([]);
  });

  it('appends validated --model and --effort', () => {
    expect(agentFlags({ ...base, model: 'opus', effort: 'high' })).toEqual([
      '--model', 'opus', '--effort', 'high',
    ]);
  });

  it('drops an invalid effort and an unsafe model', () => {
    expect(agentFlags({ ...base, model: 'opus --dangerously', effort: 'turbo' })).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('builds the Jira ticket prompt when there is no free-form task', () => {
    const task: AgentTask = { ticketId: 'X-1', title: 'T', repo: 'o/r', jiraBaseUrl: '' };
    const prompt: string = buildPrompt(task);
    expect(prompt).toContain('X-1');
    expect(prompt).toContain('Jira ticket');
    expect(prompt).toContain('open a pull request with the ticket id in the title');
  });

  it('builds a free-form prompt that omits any Jira ticket reference', () => {
    const task: AgentTask = {
      ticketId: 'freeform',
      title: '',
      repo: 'o/r',
      jiraBaseUrl: '',
      task: 'Add a healthcheck',
    };
    const prompt: string = buildPrompt(task);
    expect(prompt).toContain('Add a healthcheck');
    expect(prompt).toContain('push it and open a pull request');
    expect(prompt).toContain('Do NOT merge the PR');
    expect(prompt).not.toContain('Jira ticket');
  });

  it('builds a rerun prompt that targets the same PR branch and omits Jira ticket and open-PR language', () => {
    const task: AgentTask = {
      ticketId: 'rerun',
      title: '',
      repo: 'o/r',
      jiraBaseUrl: '',
      task: 'address it',
      prBranch: 'fix/x',
      prNumber: 12,
    };
    const prompt: string = buildPrompt(task);
    expect(prompt).toContain('#12');
    expect(prompt).toContain('fix/x');
    expect(prompt).toContain('address it');
    expect(prompt).toContain('push to the same branch');
    expect(prompt).toContain('do NOT open a new pull request');
    expect(prompt).not.toContain('Jira ticket');
  });

  it('builds a review prompt that targets the PR branch and forbids code changes, push, merge, or approval', () => {
    const task: AgentTask = {
      ticketId: 'review',
      title: '',
      repo: 'o/r',
      jiraBaseUrl: '',
      prBranch: 'fix/x',
      prNumber: 12,
      review: true,
    };
    const prompt: string = buildPrompt(task);
    expect(prompt).toContain('code-review');
    expect(prompt).toContain('#12');
    expect(prompt).toContain('.agent-review.md');
    expect(prompt).toContain('Review the whole change path, not just the diff');
    expect(prompt).toContain('Do NOT');
    expect(prompt).toContain('push');
    expect(prompt).toContain('merge');
    expect(prompt).toContain('approve');
    expect(prompt).toContain('existing');
    expect(prompt).toContain('comments');
    expect(prompt).not.toContain('Address this review feedback');
  });
});

describe('claudeCodeAdapter', () => {
  const base: AgentTask = { ticketId: 'T-1', title: 't', repo: 'o/r', jiraBaseUrl: '' };

  it('has id claude-code', () => {
    expect(claudeCodeAdapter.id).toBe('claude-code');
  });

  it('buildCommand runs claude with -p, stream-json output, and skip-permissions', () => {
    const { cmd, args } = claudeCodeAdapter.buildCommand(base);
    expect(cmd).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(buildPrompt(base));
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('buildCommand appends agentFlags for model and effort', () => {
    const { args } = claudeCodeAdapter.buildCommand({ ...base, model: 'opus', effort: 'high' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('parseLine delegates to the stream-json mapper', () => {
    expect(claudeCodeAdapter.parseLine('')).toBeNull();
    expect(claudeCodeAdapter.parseLine('not json')).toBeNull();
    const event = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.5 }),
    );
    expect(event).toEqual({ kind: 'result', text: 'done', costUsd: 0.5, prNumber: undefined });
  });
});
