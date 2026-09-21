import { describe, expect, it } from 'vitest';
import type { RunRow } from './db';
import { launchResources, restoredResources } from './run-reservations';

describe('voyage reservations', () => {
  it('reserves fresh branches and ticket identities before external reads', () => {
    expect(launchResources('run-1', { repo: 'o/r', ticketId: 'T-1' })).toEqual({ ticketId: 'T-1', branch: 'agent/run-1' });
    expect(launchResources('run-2', { repo: 'o/r', mode: 'todo', todoId: 'TODO-1' })).toEqual({ ticketId: 'TODO-1', branch: 'agent/run-2' });
    expect(launchResources('run-3', { repo: 'o/r', task: 'Do something' })).toEqual({ branch: 'agent/run-3' });
  });

  it('reserves PR identity before lookup and adds the real writable branch after lookup', () => {
    const intent = { repo: 'o/r', mode: 'rerun', prNumber: 42 };
    expect(launchResources('run-1', intent)).toEqual({ prNumber: 42 });
    expect(launchResources('run-1', intent, { ticketId: 'rerun', prNumber: 42, prBranch: 'feature' })).toEqual({ prNumber: 42, branch: 'feature' });
  });

  it('allows pinned detached reviews but reserves legacy branch-based reviews', () => {
    const intent = { repo: 'o/r', mode: 'review', prNumber: 42 };
    expect(launchResources('review', intent)).toEqual({});
    expect(launchResources('review', intent, { review: true, prHeadSha: 'a'.repeat(40), prBranch: 'feature', prNumber: 42 })).toEqual({});
    expect(launchResources('review', intent, { review: true, prBranch: 'feature', prNumber: 42 })).toEqual({ branch: 'feature', prNumber: 42 });
  });

  it('restores writable branch and task identities for recovered and resumed runs', () => {
    const row = { id: 'run-1', repo: 'o/r', ticketId: 'T-1', taskJson: JSON.stringify({ ticketId: 'T-1' }) } as RunRow;
    expect(restoredResources(row)).toEqual({ ticketId: 'T-1', branch: 'agent/run-1' });
    expect(restoredResources({ ...row, ticketId: 'rerun', taskJson: JSON.stringify({ ticketId: 'rerun', prNumber: 42, prBranch: 'feature' }) }))
      .toEqual({ prNumber: 42, branch: 'feature' });
    expect(restoredResources({ ...row, taskJson: JSON.stringify({ review: true, prHeadSha: 'a'.repeat(40) }) })).toEqual({});
    expect(restoredResources({ ...row, taskJson: '{' })).toEqual({ ticketId: 'T-1', branch: 'agent/run-1' });
    expect(restoredResources({ ...row, ticketId: 'review', prNumber: 42, taskJson: null })).toEqual({ prNumber: 42, branch: 'agent/run-1' });
  });
});
