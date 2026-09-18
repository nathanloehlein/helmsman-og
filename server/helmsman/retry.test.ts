import { describe, expect, it } from 'vitest';
import { launchIntentJson, retryIntent } from './retry';
import type { RunRow } from './db';

const row: RunRow = { id: 'old-run', ticketId: 'PROJ-1', repo: 'owner/repo', adapter: 'pre-pr:codex', status: 'failed', attempt: 1, prNumber: null, startedAt: '', endedAt: '', costUsd: null, worktreePath: '/old/worktree' };
const withTask = (task: unknown): RunRow => ({ ...row, taskJson: JSON.stringify(task) });

describe('retry intent reconstruction', () => {
  it('rebuilds Jira coding from legacy task metadata without reusing old head/worktree or description', () => {
    const intent = retryIntent(withTask({ ticketId: 'AIROBUILD-5319', title: 'Old title', repo: row.repo, jiraContext: 'stale', model: 'gpt-5.5', effort: 'xhigh' }));
    expect(intent).toEqual({ mode: 'ticket', ticketId: 'AIROBUILD-5319', repo: row.repo, adapter: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('recovers old Jira failures before taskJson was stored', () => {
    expect(retryIntent(row)).toEqual({ mode: 'ticket', ticketId: 'PROJ-1', repo: row.repo, adapter: 'codex' });
  });

  it('rebuilds freeform work with exact task and original provider', () => {
    expect(retryIntent({ ...withTask({ task: 'Implement X\nPreserve Y', model: 'sonnet', effort: 'high' }), adapter: 'pre-pr:claude-code' }))
      .toEqual({ repo: row.repo, adapter: 'claude-code', mode: 'freeform', task: 'Implement X\nPreserve Y', model: 'sonnet', effort: 'high' });
  });

  it('recovers review intent and model but discards stale PR revision and branch', () => {
    expect(retryIntent(withTask({ review: true, prNumber: 42, prHeadSha: 'stale', prBranch: 'old', model: 'gpt-6-astra', effort: 'minimal' })))
      .toEqual({ repo: row.repo, adapter: 'codex', mode: 'review', prNumber: 42, model: 'gpt-6-astra', effort: 'minimal' });
    expect(retryIntent({ ...row, ticketId: 'review', prNumber: 42 }).mode).toBe('review');
  });

  it('preserves PR update feedback including intentionally empty feedback', () => {
    for (const feedback of ['Fix missing error handling.', '']) {
      expect(retryIntent(withTask({ prBranch: 'old', prNumber: 42, task: feedback })))
        .toEqual({ repo: row.repo, adapter: 'codex', mode: 'rerun', prNumber: 42, feedback });
    }
  });

  it('uses todo identity instead of treating rendered todo requirements as freeform', () => {
    expect(retryIntent(withTask({ todoId: 'TODO-7', task: 'old todo description' })))
      .toEqual({ repo: row.repo, adapter: 'codex', mode: 'todo', todoId: 'TODO-7' });
  });

  it.each([
    { mode: 'review', prNumber: 12 },
    { mode: 'rerun', prNumber: 12, feedback: 'Fix it.' },
    { mode: 'freeform', task: 'Do the work.' },
    { mode: 'ticket', ticketId: 'PROJ-9' },
    { mode: 'todo', todoId: 'TODO-9' },
  ])('recovers persisted pre-start intent for $mode', saved => {
    const intent = { repo: row.repo, ...saved, model: 'gpt-5.5', effort: 'high' };
    expect(retryIntent({ ...row, ticketId: 'freeform', launchJson: launchIntentJson(intent) }))
      .toEqual({ ...intent, adapter: 'codex' });
  });

  it('retains runtime-selected review tuning and only serializes launch fields', () => {
    const launchJson = launchIntentJson({ repo: row.repo, mode: 'review', prNumber: 42, runId: 'old-id', headSha: 'stale', retryOf: 'other' } as never);
    expect(JSON.parse(launchJson)).toEqual({ repo: row.repo, mode: 'review', prNumber: 42 });
    expect(retryIntent({ ...withTask({ model: 'gpt-5.5', effort: 'high' }), launchJson }))
      .toMatchObject({ mode: 'review', model: 'gpt-5.5', effort: 'high' });
  });

  it.each([
    { status: 'running' }, { status: 'succeeded' }, { status: 'stopped' },
    { ticketId: 'freeform' }, { ticketId: 'rerun', prNumber: 42 }, { ticketId: 'TODO-1' },
    { taskJson: 'bad JSON' }, { taskJson: 'null' }, { launchJson: '[]' },
    { adapter: 'missing' }, { repo: '../repo' }, { taskJson: JSON.stringify({ repo: 'other/repo' }) },
    { launchJson: JSON.stringify({ mode: 'review', prNumber: -1 }) },
    { launchJson: JSON.stringify({ mode: 'freeform', task: '' }) },
  ])('rejects unsafe or unrecoverable metadata: %j', override => {
    expect(() => retryIntent({ ...row, ...override } as RunRow)).toThrow();
  });
});
