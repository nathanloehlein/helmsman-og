// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedbackUpdateAdapter } from './feedback-update';
import { codexAdapter } from './codex';
import { restoreRunAdapter } from './restore';
import { retryIntent } from '../retry';
import type { AgentTask } from './adapter';
import type { RunRow } from '../db';
import { joinArgumentChunks } from '../argv-chunks';

const task: AgentTask = { ticketId: 'rerun', title: 'Update', repo: 'o/r', jiraBaseUrl: '', prNumber: 11104, prBranch: 'fix/svg', feedbackWorkflow: true, task: 'Address feedback' };

describe('feedback update adapter', () => {
  it('launches the completion workflow on the existing PR', () => {
    const command = feedbackUpdateAdapter(codexAdapter, '/runs').buildCommand(task);
    expect(command.args[2]).toContain('feedback-update-cli.ts');
    expect(JSON.parse(joinArgumentChunks(command.args.slice(3)))).toMatchObject({ task, writerId: 'codex', runsDir: '/runs' });
  });

  it.each([{ ...task, review: true }, { ...task, feedbackWorkflow: undefined }, { ...task, prNumber: undefined }, { ...task, prBranch: undefined }])(
    'rejects non-feedback launches', invalid => {
      expect(() => feedbackUpdateAdapter(codexAdapter, '/runs').buildCommand(invalid)).toThrow('existing PR update');
    });

  it.each(['codex', 'claude-code'])('restores feedback completion events from %s after a restart', provider => {
    const restored = restoreRunAdapter({ adapter: `feedback:${provider}`, taskJson: JSON.stringify(task) }, { runsDir: '/runs' });
    const event = { kind: 'feedback-outcome', text: JSON.stringify({ state: 'changes_remaining', headSha: 'a'.repeat(40), summary: 'Unresolved finding' }) };
    expect(restored.id).toBe(`feedback:${provider}`);
    expect(restored.parseLine(JSON.stringify({ __helmsmanPrePr: 1, ...event }))).toEqual(event);
  });

  it('retries failed feedback without losing the provider, PR, or requested work', () => {
    const row: RunRow = { id: 'r1', ticketId: 'rerun', repo: 'o/r', status: 'failed', adapter: 'feedback:claude-code',
      prNumber: 11104, worktreePath: null, attempt: 1, startedAt: '', endedAt: '', costUsd: null, taskJson: JSON.stringify(task) };
    expect(retryIntent(row)).toMatchObject({ adapter: 'claude-code', repo: 'o/r', mode: 'rerun', prNumber: 11104, feedback: 'Address feedback' });
  });
});
