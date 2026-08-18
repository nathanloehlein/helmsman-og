import { describe, expect, it, vi } from 'vitest';
import { startRun, type RunnerDeps } from './runner';
import { RunBus } from './event-bus';
import { openDb, type Db } from './db';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentTask } from './agents/adapter';

const task: AgentTask = { ticketId: 'LEKA-1', title: 'do it', repo: 'o/r', jiraBaseUrl: 'https://x' };

function fakeAdapter(events: AgentEvent[], ok: boolean, prNumber?: number): AgentAdapter {
  return {
    id: 'fake',
    start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
      for (const e of events) onEvent(e);
      return { stop: () => undefined, exit: Promise.resolve({ ok, prNumber, costUsd: 0.1 }) };
    },
  };
}

function deps(db: Db, adapter: AgentAdapter): RunnerDeps {
  return {
    db, bus: new RunBus(), adapter,
    createWorktree: async () => ({ path: '/tmp/wt', branch: 'agent/x' }),
    removeWorktree: vi.fn(async () => undefined),
    now: () => '2026-08-18T00:00:00.000Z',
    genId: () => 'run-1',
  };
}

describe('startRun', () => {
  it('records events and marks the run succeeded with the PR + cost', async () => {
    const db: Db = openDb(':memory:');
    const d = deps(db, fakeAdapter([{ kind: 'phase', text: 'exploring' }, { kind: 'result', text: 'done', costUsd: 0.1 }], true, 7));
    const id = await startRun(task, d);
    expect(id).toBe('run-1');
    const row = db.getRun('run-1');
    expect(row?.status).toBe('succeeded');
    expect(row?.prNumber).toBe(7);
    expect(row?.costUsd).toBe(0.1);
    expect(db.listEvents('run-1').some((e) => e.text === 'exploring')).toBe(true);
    expect(d.removeWorktree).toHaveBeenCalledOnce();
    db.close();
  });

  it('marks failed when the adapter exits not-ok', async () => {
    const db: Db = openDb(':memory:');
    const id = await startRun(task, deps(db, fakeAdapter([], false)));
    expect(db.getRun(id)?.status).toBe('failed');
    db.close();
  });

  it('persists a failed run row and error event, and does not remove a worktree, when createWorktree rejects', async () => {
    const db: Db = openDb(':memory:');
    const remove = vi.fn(async () => undefined);
    const d: RunnerDeps = { ...deps(db, fakeAdapter([], true)), createWorktree: async () => { throw new Error('git fail'); }, removeWorktree: remove };
    const id = await startRun(task, d);
    const row = db.getRun(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.worktreePath).toBeNull();
    expect(db.listEvents(id).some((e) => e.kind === 'error' && e.text === 'git fail')).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    db.close();
  });
});
