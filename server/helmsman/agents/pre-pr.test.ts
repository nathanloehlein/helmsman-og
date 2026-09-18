// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codex';
import { claudeCodeAdapter } from './claude-code';
import { commandAdapter } from './command';
import { isPrePrAdapter, prePrAdapter } from './pre-pr';

const task = { ticketId: 'T-1', title: 'Fix the bug', repo: 'org/repo', jiraBaseUrl: '' };

describe('durable pre-PR adapter', () => {
  it.each([codexAdapter, claudeCodeAdapter])('wraps $id in the durable workflow with its author settings', writer => {
    const adapter = prePrAdapter(writer, '/tmp/run files');
    const command = adapter.buildCommand({ ...task, model: 'selected-model', effort: 'low' });
    expect(isPrePrAdapter(adapter.id)).toBe(true);
    expect(command.cmd).toBe(process.execPath);
    expect(command.args[0]).toBe('--import');
    expect(command.args[2]).toMatch(/pre-pr-cli\.ts$/);
    expect(JSON.parse(command.args[3] ?? '')).toEqual({ task: { ...task, model: 'selected-model', effort: 'low' }, writerId: writer.id, runsDir: '/tmp/run files',
      settings: { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 } });
  });

  it('snapshots settings into the durable command without following later config edits', () => {
    const settings = { reviewerCount: 1, maxRounds: 5, stageTimeoutMinutes: 90 };
    const adapter = prePrAdapter(codexAdapter, '/tmp', settings);
    settings.maxRounds = 1;
    expect(JSON.parse(adapter.buildCommand(task).args[3] ?? '').settings).toEqual({ reviewerCount: 1, maxRounds: 5, stageTimeoutMinutes: 90 });
  });

  it('does not bypass the gate for unsupported adapters or existing PRs', () => {
    expect(() => prePrAdapter(commandAdapter('echo'), '/tmp')).toThrow('requires');
    const adapter = prePrAdapter(codexAdapter, '/tmp');
    expect(() => adapter.buildCommand({ ...task, prBranch: 'existing' })).toThrow('only for new');
    expect(() => adapter.buildCommand({ ...task, review: true })).toThrow('only for new');
    expect(isPrePrAdapter('pre-pr:unknown')).toBe(false);
  });

  it('records a PR number only from a successful publication event, not reviewer output', () => {
    const adapter = prePrAdapter(codexAdapter, '/tmp');
    expect(adapter.parseLine('examined https://github.com/org/repo/pull/99')?.prNumber).toBeUndefined();
    expect(adapter.parseLine(JSON.stringify({ __helmsmanPrePr: 1, kind: 'log', text: 'review', prNumber: 99 }))?.prNumber).toBeUndefined();
    expect(adapter.parseLine(JSON.stringify({ __helmsmanPrePr: 1, kind: 'result', text: 'Opened PR #42', prNumber: 42, costUsd: 1 }))).toEqual({ kind: 'result', text: 'Opened PR #42', prNumber: 42, costUsd: 1 });
    expect(adapter.parseLine(JSON.stringify({ __helmsmanPrePr: 1, kind: 'result', text: 'invalid', prNumber: -1, costUsd: -1 }))).toEqual({ kind: 'result', text: 'invalid' });
  });
});
