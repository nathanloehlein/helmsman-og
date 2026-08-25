import { describe, expect, it, vi } from 'vitest';
import { startRun, type RunnerDeps } from './runner';
import { RunBus } from './event-bus';
import { openDb, type Db } from './db';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentTask } from './agents/adapter';

const task: AgentTask = { ticketId: 'LEKA-1', title: 'do it', repo: 'o/r', jiraBaseUrl: 'https://x' };
const freeformTask: AgentTask = { ticketId: 'freeform', title: '', repo: 'o/r', jiraBaseUrl: '', task: 'do X' };

function fakeAdapter(events: AgentEvent[], ok: boolean, prNumber?: number): AgentAdapter {
  return {
    id: 'fake',
    start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
      for (const e of events) onEvent(e);
      return { stop: () => undefined, exit: Promise.resolve({ ok, prNumber, costUsd: 0.1 }) };
    },
  };
}

function flakyAdapter(failures: number, events: AgentEvent[], prNumber?: number): AgentAdapter {
  let calls: number = 0;
  return {
    id: 'flaky',
    start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
      calls += 1;
      const ok: boolean = calls > failures;
      for (const e of events) onEvent(e);
      return { stop: () => undefined, exit: Promise.resolve({ ok, prNumber, costUsd: 0.1 }) };
    },
  };
}

function sequenceAdapter(results: Array<{ ok: boolean; costUsd?: number; prNumber?: number }>): AgentAdapter {
  let calls: number = 0;
  return {
    id: 'sequence',
    start(_t: AgentTask, _wd: string, _onEvent: (e: AgentEvent) => void): AgentHandle {
      const result = results[Math.min(calls, results.length - 1)];
      calls += 1;
      return { stop: () => undefined, exit: Promise.resolve(result) };
    },
  };
}

function fakeJira(): JiraActions & { assignCalls: Array<{ ticketId: string; accountId: string }>; transitionCalls: Array<{ ticketId: string; statusName: string }> } {
  const assignCalls: Array<{ ticketId: string; accountId: string }> = [];
  const transitionCalls: Array<{ ticketId: string; statusName: string }> = [];
  return {
    assignCalls,
    transitionCalls,
    async assign(ticketId: string, accountId: string): Promise<void> {
      assignCalls.push({ ticketId, accountId });
    },
    async transition(ticketId: string, statusName: string): Promise<boolean> {
      transitionCalls.push({ ticketId, statusName });
      return true;
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

  it('assigns the bot and transitions to In Progress before the adapter runs', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    let adapterCalledAfterTransition: boolean = false;
    const adapter: AgentAdapter = {
      id: 'fake',
      start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
        adapterCalledAfterTransition = jira.transitionCalls.length > 0 && jira.assignCalls.length > 0;
        onEvent({ kind: 'result', text: 'done' });
        return { stop: () => undefined, exit: Promise.resolve({ ok: true, costUsd: 0.1 }) };
      },
    };
    const d: RunnerDeps = { ...deps(db, adapter), jira, botAccountId: 'bot-acc' };

    await startRun(task, d);

    expect(jira.assignCalls).toEqual([{ ticketId: 'LEKA-1', accountId: 'bot-acc' }]);
    expect(jira.transitionCalls[0]).toEqual({ ticketId: 'LEKA-1', statusName: 'In Progress' });
    expect(adapterCalledAfterTransition).toBe(true);
    db.close();
  });

  it('transitions to In Review and sets prNumber when a PR is detected on success', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 42);
    const d: RunnerDeps = { ...deps(db, fakeAdapter([], true)), jira, botAccountId: 'bot-acc', findPrNumber };

    const id = await startRun(task, d);

    expect(findPrNumber).toHaveBeenCalledWith('o/r', 'agent/x');
    const row = db.getRun(id);
    expect(row?.prNumber).toBe(42);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
    db.close();
  });

  it('uses the adapter-parsed PR number and does not call findPrNumber (fallback-only)', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 999);
    const d: RunnerDeps = { ...deps(db, fakeAdapter([], true, 8922)), jira, botAccountId: 'bot-acc', findPrNumber };

    const id = await startRun(task, d);

    expect(findPrNumber).not.toHaveBeenCalled();
    const row = db.getRun(id);
    expect(row?.prNumber).toBe(8922);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
    db.close();
  });

  it('retries a failing adapter up to maxAttempts, then succeeds and reaches In Review', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async () => 99);
    const adapter: AgentAdapter = flakyAdapter(1, []);
    const d: RunnerDeps = { ...deps(db, adapter), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 2 };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.attempt).toBe(2);
    expect(row?.prNumber).toBe(99);
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('retry'))).toBe(true);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
    db.close();
  });

  it('fails after exhausting maxAttempts and never transitions to In Review', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async () => 99);
    const adapter: AgentAdapter = flakyAdapter(5, []);
    const d: RunnerDeps = { ...deps(db, adapter), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 2 };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('failed');
    expect(row?.attempt).toBe(2);
    expect(findPrNumber).not.toHaveBeenCalled();
    expect(jira.transitionCalls.every((c) => c.statusName !== 'In Review')).toBe(true);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Progress' });
    db.close();
  });

  it('stops retrying and marks the run stopped when isStopped signals a stop after a failed attempt', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async () => 99);
    let calls: number = 0;
    const adapter: AgentAdapter = {
      id: 'fake',
      start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
        calls += 1;
        onEvent({ kind: 'result', text: 'not ok' });
        return { stop: () => undefined, exit: Promise.resolve({ ok: false, costUsd: 0.1 }) };
      },
    };
    const isStopped = vi.fn(() => true);
    const d: RunnerDeps = { ...deps(db, adapter), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 3, isStopped };

    const id = await startRun(task, d);

    expect(calls).toBe(1);
    const row = db.getRun(id);
    expect(row?.status).toBe('stopped');
    expect(findPrNumber).not.toHaveBeenCalled();
    expect(jira.transitionCalls.every((c) => c.statusName !== 'In Review')).toBe(true);
    db.close();
  });

  it('marks the run stopped, not failed, when a stop and the cost cap collide on the same attempt', async () => {
    const db: Db = openDb(':memory:');
    let calls: number = 0;
    const adapter: AgentAdapter = {
      id: 'collision',
      start(_t: AgentTask, _wd: string, _onEvent: (e: AgentEvent) => void): AgentHandle {
        calls += 1;
        return { stop: () => undefined, exit: Promise.resolve({ ok: false, costUsd: 0.6 }) };
      },
    };
    const isStopped = vi.fn(() => true);
    const d: RunnerDeps = { ...deps(db, adapter), maxAttempts: 3, maxCostUsd: 0.5, isStopped };

    const id = await startRun(task, d);

    expect(calls).toBe(1);
    const row = db.getRun(id);
    expect(row?.status).toBe('stopped');
    db.close();
  });

  it('accumulates cost across retried attempts', async () => {
    const db: Db = openDb(':memory:');
    const adapter: AgentAdapter = sequenceAdapter([{ ok: false, costUsd: 0.1 }, { ok: true, costUsd: 0.2 }]);
    const d: RunnerDeps = { ...deps(db, adapter), maxAttempts: 2 };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.costUsd).toBeCloseTo(0.3);
    db.close();
  });

  it('stops before exceeding maxCostUsd and marks the run failed with a cost-cap log', async () => {
    const db: Db = openDb(':memory:');
    let calls: number = 0;
    const adapter: AgentAdapter = {
      id: 'cost',
      start(_t: AgentTask, _wd: string, _onEvent: (e: AgentEvent) => void): AgentHandle {
        calls += 1;
        return { stop: () => undefined, exit: Promise.resolve({ ok: false, costUsd: 0.6 }) };
      },
    };
    const d: RunnerDeps = { ...deps(db, adapter), maxAttempts: 3, maxCostUsd: 1.0 };

    const id = await startRun(task, d);

    expect(calls).toBe(2);
    const row = db.getRun(id);
    expect(row?.status).toBe('failed');
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('cost cap'))).toBe(true);
    db.close();
  });

  it('runs the full maxAttempts when maxCostUsd is not set (cap is opt-in)', async () => {
    const db: Db = openDb(':memory:');
    let calls: number = 0;
    const adapter: AgentAdapter = {
      id: 'cost',
      start(_t: AgentTask, _wd: string, _onEvent: (e: AgentEvent) => void): AgentHandle {
        calls += 1;
        return { stop: () => undefined, exit: Promise.resolve({ ok: false, costUsd: 0.6 }) };
      },
    };
    const d: RunnerDeps = { ...deps(db, adapter), maxAttempts: 3, maxCostUsd: null };

    await startRun(task, d);

    expect(calls).toBe(3);
    db.close();
  });

  it('does not crash when jira.assign/transition throw, and still runs the adapter', async () => {
    const db: Db = openDb(':memory:');
    const jira: JiraActions = {
      assign: async () => { throw new Error('assign boom'); },
      transition: async () => { throw new Error('transition boom'); },
    };
    const d: RunnerDeps = { ...deps(db, fakeAdapter([], true, 5)), jira, botAccountId: 'bot-acc' };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('non-fatal'))).toBe(true);
    db.close();
  });

  it('does not crash when findPrNumber rejects', async () => {
    const db: Db = openDb(':memory:');
    const findPrNumber = vi.fn(async () => { throw new Error('lookup boom'); });
    const d: RunnerDeps = { ...deps(db, fakeAdapter([], true)), findPrNumber };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('non-fatal'))).toBe(true);
    db.close();
  });

  it('behaves exactly like P1 when jira and findPrNumber deps are absent', async () => {
    const db: Db = openDb(':memory:');
    const id = await startRun(task, deps(db, fakeAdapter([{ kind: 'phase', text: 'exploring' }], true, 7)));
    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.prNumber).toBe(7);
    expect(row?.attempt).toBe(1);
    db.close();
  });

  it('publishes a single run-complete event with the final status, after the run row is already terminal, on success', async () => {
    const db: Db = openDb(':memory:');
    const d: RunnerDeps = deps(db, fakeAdapter([{ kind: 'result', text: 'done' }], true, 7));
    const completeEvents: AgentEvent[] = [];
    const statusesAtRunComplete: Array<string | undefined> = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => {
      if (e.kind !== 'run-complete') return;
      completeEvents.push(e);
      statusesAtRunComplete.push(db.getRun('run-1')?.status);
    });

    const id = await startRun(task, d);

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].text).toBe('succeeded');
    expect(statusesAtRunComplete).toEqual(['succeeded']);
    expect(statusesAtRunComplete[0]).not.toBe('running');
    expect(db.listEvents(id).filter((e) => e.kind === 'run-complete')).toHaveLength(1);
    db.close();
  });

  it('never claims or transitions a free-form run, even when jira and botAccountId are configured', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async () => 42);
    const d: RunnerDeps = { ...deps(db, fakeAdapter([{ kind: 'result', text: 'done' }], true)), jira, botAccountId: 'bot-acc', findPrNumber };

    const id = await startRun(freeformTask, d);

    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.ticketId).toBe('freeform');
    db.close();
  });

  it('reruns on an existing PR branch using createWorktreeFromBranch, skips jira claim/review, and records the PR number', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt', branch: 'fix/x' }));
    const createWorktree = vi.fn(async () => ({ path: '/tmp/wt', branch: 'agent/x' }));
    let adapterRan: boolean = false;
    const adapter: AgentAdapter = {
      id: 'fake',
      start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
        adapterRan = true;
        onEvent({ kind: 'result', text: 'done' });
        return { stop: () => undefined, exit: Promise.resolve({ ok: true, costUsd: 0.1 }) };
      },
    };
    const rerunTask: AgentTask = { ticketId: 'rerun', title: '', repo: 'o/r', jiraBaseUrl: '', task: 'address it', prBranch: 'fix/x', prNumber: 12 };
    const d: RunnerDeps = { ...deps(db, adapter), createWorktree, createWorktreeFromBranch, jira, botAccountId: 'bot-acc' };

    const id = await startRun(rerunTask, d);

    expect(createWorktreeFromBranch).toHaveBeenCalledWith('o/r', 'run-1', 'fix/x');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    const row = db.getRun(id);
    expect(row?.prNumber).toBe(12);
    expect(adapterRan).toBe(true);
    db.close();
  });

  it('never claims or transitions a rerun with empty feedback, even when jira and botAccountId are configured', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt', branch: 'fix/x' }));
    const emptyFeedbackRerunTask: AgentTask = { ticketId: 'rerun', title: '', repo: 'o/r', jiraBaseUrl: '', task: '', prBranch: 'fix/x', prNumber: 12 };
    const d: RunnerDeps = { ...deps(db, fakeAdapter([{ kind: 'result', text: 'done' }], true)), jira, botAccountId: 'bot-acc', createWorktreeFromBranch };

    const id = await startRun(emptyFeedbackRerunTask, d);

    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    db.close();
  });

  it('publishes a single run-complete event with the final status, after the run row is already terminal, on failure', async () => {
    const db: Db = openDb(':memory:');
    const d: RunnerDeps = deps(db, fakeAdapter([{ kind: 'result', text: 'nope' }], false));
    const completeEvents: AgentEvent[] = [];
    const statusesAtRunComplete: Array<string | undefined> = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => {
      if (e.kind !== 'run-complete') return;
      completeEvents.push(e);
      statusesAtRunComplete.push(db.getRun('run-1')?.status);
    });

    const id = await startRun(task, d);

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].text).toBe('failed');
    expect(statusesAtRunComplete).toEqual(['failed']);
    expect(statusesAtRunComplete[0]).not.toBe('running');
    expect(db.listEvents(id).filter((e) => e.kind === 'run-complete')).toHaveLength(1);
    db.close();
  });
});
