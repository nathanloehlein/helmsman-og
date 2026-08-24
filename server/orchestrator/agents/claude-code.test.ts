import { describe, expect, it } from 'vitest';
import { buildPrompt } from './claude-code';
import type { AgentTask } from './adapter';

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
});
