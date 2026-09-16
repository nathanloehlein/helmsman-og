import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reattachRun, startRun, type RunnerDeps } from './runner';
import { RunBus } from './event-bus';
import { openDb, type Db, type RunRow } from './db';
import type { JiraActions } from './jira-actions';
import type { AgentAdapter, AgentEvent, AgentTask } from './agents/adapter';
import type { HostRef, LaunchSpec, RunHost } from './run-host';

const task: AgentTask = { ticketId: 'LEKA-1', title: 'do it', repo: 'o/r', jiraBaseUrl: 'https://x' };
const freeformTask: AgentTask = { ticketId: 'freeform', title: '', repo: 'o/r', jiraBaseUrl: '', task: 'do X' };

function freshRunsDir(): string {
  return mkdtempSync(join(tmpdir(), 'runner-test-'));
}

function jsonAdapter(id: string = 'fake'): AgentAdapter {
  return {
    id,
    buildCommand(): { cmd: string; args: string[] } {
      return { cmd: 'node', args: ['-e', '0'] };
    },
    parseLine(line: string): AgentEvent | null {
      if (!line.trim()) return null;
      try {
        return JSON.parse(line) as AgentEvent;
      } catch {
        return null;
      }
    },
  };
}

function fakeHost(scriptFor: (attempt: number) => { events: AgentEvent[]; ok: boolean }): RunHost {
  let calls: number = 0;
  return {
    kind: 'detached',
    async launch(spec: LaunchSpec): Promise<HostRef> {
      calls += 1;
      const { events, ok } = scriptFor(calls);
      const lines: string[] = events.map((e) => JSON.stringify(e));
      writeFileSync(spec.logPath, lines.length ? lines.join('\n') + '\n' : '');
      writeFileSync(spec.exitPath, String(ok ? 0 : 1));
      return { kind: 'detached', pid: calls };
    },
    async isAlive(): Promise<boolean> {
      return false;
    },
    async stop(): Promise<void> {
      return undefined;
    },
  };
}

function withPr(events: AgentEvent[], prNumber?: number): AgentEvent[] {
  return prNumber == null ? events : [...events, { kind: 'result', text: '', prNumber }];
}

function singleAttemptHost(events: AgentEvent[], ok: boolean, prNumber?: number): RunHost {
  const full: AgentEvent[] = withPr(events, prNumber);
  return fakeHost(() => ({ events: full, ok }));
}

function flakyHost(failures: number, events: AgentEvent[], prNumber?: number): RunHost {
  const full: AgentEvent[] = withPr(events, prNumber);
  return fakeHost((attempt) => ({ events: full, ok: attempt > failures }));
}

function sequenceHost(results: Array<{ ok: boolean; costUsd?: number; prNumber?: number }>): RunHost {
  return fakeHost((attempt) => {
    const r = results[Math.min(attempt - 1, results.length - 1)]!;
    const events: AgentEvent[] = [];
    if (r.costUsd != null) events.push({ kind: 'result', text: '', costUsd: r.costUsd });
    return { events: withPr(events, r.prNumber), ok: r.ok };
  });
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

function deps(db: Db, adapter: AgentAdapter, host: RunHost, runsDir: string): RunnerDeps {
  return {
    db, bus: new RunBus(), adapter, host, runsDir,
    createWorktree: async () => ({ path: '/tmp/wt', branch: 'agent/x' }),
    removeWorktree: vi.fn(async () => undefined),
    now: () => '2026-08-18T00:00:00.000Z',
    genId: () => 'run-1',
    pollIntervalMs: 5,
  };
}

describe('startRun', () => {
  it('records events and marks the run succeeded with the PR + cost', async () => {
    const db: Db = openDb(':memory:');
    const d = deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'phase', text: 'exploring' }, { kind: 'result', text: 'done', costUsd: 0.1 }], true, 7), freshRunsDir());
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
    const id = await startRun(task, deps(db, jsonAdapter(), singleAttemptHost([], false), freshRunsDir()));
    expect(db.getRun(id)?.status).toBe('failed');
    db.close();
  });

  it('persists a failed run row and error event, and does not remove a worktree, when createWorktree rejects', async () => {
    const db: Db = openDb(':memory:');
    const remove = vi.fn(async () => undefined);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()), createWorktree: async () => { throw new Error('git fail'); }, removeWorktree: remove };
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
    let launchedAfterTransition: boolean = false;
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        launchedAfterTransition = jira.transitionCalls.length > 0 && jira.assignCalls.length > 0;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: 'done' }) + '\n');
        writeFileSync(spec.exitPath, '0');
        return { kind: 'detached', pid: 1 };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), jira, botAccountId: 'bot-acc' };

    await startRun(task, d);

    expect(jira.assignCalls).toEqual([{ ticketId: 'LEKA-1', accountId: 'bot-acc' }]);
    expect(jira.transitionCalls[0]).toEqual({ ticketId: 'LEKA-1', statusName: 'In Progress' });
    expect(launchedAfterTransition).toBe(true);
    db.close();
  });

  it('transitions to In Review and sets prNumber when a PR is detected on success', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 42);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber };

    const id = await startRun(task, d);

    expect(findPrNumber).toHaveBeenCalledWith('o/r', 'agent/x');
    const row = db.getRun(id);
    expect(row?.prNumber).toBe(42);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
    db.close();
  });

  it('requests a Copilot review on the opened PR after a successful run', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async () => 42);
    const requestCopilotReview = vi.fn(async (_repo: string, _prNumber: number) => ({ ok: true as const }));
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber, requestCopilotReview };

    await startRun(task, d);

    expect(requestCopilotReview).toHaveBeenCalledWith('o/r', 42);
    db.close();
  });

  it('does not request a Copilot review on a rerun (the PR already exists)', async () => {
    const db: Db = openDb(':memory:');
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt', branch: 'fix/x' }));
    const requestCopilotReview = vi.fn(async (_repo: string, _prNumber: number) => ({ ok: true as const }));
    const rerunTask: AgentTask = { ticketId: 'rerun', title: '', repo: 'o/r', jiraBaseUrl: '', task: 'address it', prBranch: 'fix/x', prNumber: 12 };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()), createWorktreeFromBranch, requestCopilotReview };

    await startRun(rerunTask, d);

    expect(requestCopilotReview).not.toHaveBeenCalled();
    db.close();
  });

  it('uses the adapter-parsed PR number and does not call findPrNumber (fallback-only)', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 999);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true, 8922), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber };

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
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), flakyHost(1, []), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 2 };

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
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), flakyHost(5, []), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 2 };

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
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        calls += 1;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: 'not ok' }) + '\n');
        writeFileSync(spec.exitPath, '1');
        return { kind: 'detached', pid: calls };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const isStopped = vi.fn(() => true);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber, maxAttempts: 3, isStopped };

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
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        calls += 1;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: '', costUsd: 0.6 }) + '\n');
        writeFileSync(spec.exitPath, '1');
        return { kind: 'detached', pid: calls };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const isStopped = vi.fn(() => true);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), maxAttempts: 3, maxCostUsd: 0.5, isStopped };

    const id = await startRun(task, d);

    expect(calls).toBe(1);
    const row = db.getRun(id);
    expect(row?.status).toBe('stopped');
    db.close();
  });

  it('accumulates cost across retried attempts', async () => {
    const db: Db = openDb(':memory:');
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), sequenceHost([{ ok: false, costUsd: 0.1 }, { ok: true, costUsd: 0.2 }]), freshRunsDir()), maxAttempts: 2 };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.costUsd).toBeCloseTo(0.3);
    db.close();
  });

  it('stops before exceeding maxCostUsd and marks the run failed with a cost-cap log', async () => {
    const db: Db = openDb(':memory:');
    let calls: number = 0;
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        calls += 1;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: '', costUsd: 0.6 }) + '\n');
        writeFileSync(spec.exitPath, '1');
        return { kind: 'detached', pid: calls };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), maxAttempts: 3, maxCostUsd: 1.0 };

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
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        calls += 1;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: '', costUsd: 0.6 }) + '\n');
        writeFileSync(spec.exitPath, '1');
        return { kind: 'detached', pid: calls };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), maxAttempts: 3, maxCostUsd: null };

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
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true, 5), freshRunsDir()), jira, botAccountId: 'bot-acc' };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('non-fatal'))).toBe(true);
    db.close();
  });

  it('does not crash when findPrNumber rejects', async () => {
    const db: Db = openDb(':memory:');
    const findPrNumber = vi.fn(async () => { throw new Error('lookup boom'); });
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()), findPrNumber };

    const id = await startRun(task, d);

    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(db.listEvents(id).some((e) => e.kind === 'log' && e.text.includes('non-fatal'))).toBe(true);
    db.close();
  });

  it('behaves exactly like P1 when jira and findPrNumber deps are absent', async () => {
    const db: Db = openDb(':memory:');
    const id = await startRun(task, deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'phase', text: 'exploring' }], true, 7), freshRunsDir()));
    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    expect(row?.prNumber).toBe(7);
    expect(row?.attempt).toBe(1);
    db.close();
  });

  it('publishes a single run-complete event with the final status, after the run row is already terminal, on success', async () => {
    const db: Db = openDb(':memory:');
    const d: RunnerDeps = deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true, 7), freshRunsDir());
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
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()), jira, botAccountId: 'bot-acc', findPrNumber };

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
    let hostLaunched: boolean = false;
    const host: RunHost = {
      kind: 'detached',
      async launch(spec: LaunchSpec): Promise<HostRef> {
        hostLaunched = true;
        writeFileSync(spec.logPath, JSON.stringify({ kind: 'result', text: 'done' }) + '\n');
        writeFileSync(spec.exitPath, '0');
        return { kind: 'detached', pid: 1 };
      },
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const rerunTask: AgentTask = { ticketId: 'rerun', title: '', repo: 'o/r', jiraBaseUrl: '', task: 'address it', prBranch: 'fix/x', prNumber: 12 };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), host, freshRunsDir()), createWorktree, createWorktreeFromBranch, jira, botAccountId: 'bot-acc' };

    const id = await startRun(rerunTask, d);

    expect(createWorktreeFromBranch).toHaveBeenCalledWith('o/r', 'run-1', 'fix/x');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    const row = db.getRun(id);
    expect(row?.prNumber).toBe(12);
    expect(hostLaunched).toBe(true);
    db.close();
  });

  it('never claims or transitions a rerun with empty feedback, even when jira and botAccountId are configured', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt', branch: 'fix/x' }));
    const emptyFeedbackRerunTask: AgentTask = { ticketId: 'rerun', title: '', repo: 'o/r', jiraBaseUrl: '', task: '', prBranch: 'fix/x', prNumber: 12 };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()), jira, botAccountId: 'bot-acc', createWorktreeFromBranch };

    const id = await startRun(emptyFeedbackRerunTask, d);

    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    const row = db.getRun(id);
    expect(row?.status).toBe('succeeded');
    db.close();
  });

  it('reads .agent-review.md from the worktree and posts it as a PR comment before the worktree is removed', async () => {
    const db: Db = openDb(':memory:');
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt-review', branch: 'fix/x' }));
    const removeWorktree = vi.fn(async () => undefined);
    const readReview = vi.fn(async (_worktreePath: string) => '## Review\nlooks fine');
    const postReview = vi.fn(async (_repo: string, _prNumber: number, _body: string) => ({ ok: true as const }));
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 12, review: true };
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()),
      createWorktreeFromBranch,
      removeWorktree,
      readReview,
      postReview,
    };

    const events: AgentEvent[] = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => { events.push(e); });

    await startRun(reviewTask, d);

    expect(readReview).toHaveBeenCalledWith('/tmp/wt-review');
    expect(postReview).toHaveBeenCalledWith('o/r', 12, '## Review\nlooks fine');
    expect(readReview.mock.invocationCallOrder[0]).toBeLessThan(removeWorktree.mock.invocationCallOrder[0]);
    expect(events.some((e) => e.kind === 'log' && e.text.includes('posted code-review comment on PR #12'))).toBe(true);
    db.close();
  });

  it('fails the review run (not silent success) when the agent produced no .agent-review.md', async () => {
    const db: Db = openDb(':memory:');
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt-review', branch: 'fix/x' }));
    const readReview = vi.fn(async (_worktreePath: string) => null);
    const postReview = vi.fn(async (_repo: string, _prNumber: number, _body: string) => ({ ok: true as const }));
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 12, review: true };
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()),
      createWorktreeFromBranch,
      readReview,
      postReview,
    };

    const events: AgentEvent[] = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => { events.push(e); });

    const id = await startRun(reviewTask, d);

    expect(postReview).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'error' && e.text.includes('no .agent-review.md'))).toBe(true);
    expect(db.getRun(id)?.status).toBe('failed');
    db.close();
  });

  it('fails the review run when postReview fails', async () => {
    const db: Db = openDb(':memory:');
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt-review', branch: 'fix/x' }));
    const readReview = vi.fn(async (_worktreePath: string) => 'body');
    const postReview = vi.fn(async (_repo: string, _prNumber: number, _body: string) => ({ ok: false as const, error: 'boom' }));
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 12, review: true };
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()),
      createWorktreeFromBranch,
      readReview,
      postReview,
    };

    const events: AgentEvent[] = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => { events.push(e); });

    const id = await startRun(reviewTask, d);

    expect(events.some((e) => e.kind === 'error' && e.text.includes('boom'))).toBe(true);
    expect(db.getRun(id)?.status).toBe('failed');
    db.close();
  });

  it('posts the review and succeeds even when the adapter exits non-zero, as long as .agent-review.md was written', async () => {
    const db: Db = openDb(':memory:');
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt-review', branch: 'fix/x' }));
    const readReview = vi.fn(async (_worktreePath: string) => '## Review\nfindings');
    const postReview = vi.fn(async (_repo: string, _prNumber: number, _body: string) => ({ ok: true as const }));
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 12, review: true };
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], false), freshRunsDir()),
      createWorktreeFromBranch,
      readReview,
      postReview,
    };

    const id = await startRun(reviewTask, d);

    expect(postReview).toHaveBeenCalledWith('o/r', 12, '## Review\nfindings');
    expect(db.getRun(id)?.status).toBe('succeeded');
    db.close();
  });

  it('never claims Jira, transitions Jira, or calls findPrNumber for a review run', async () => {
    const db: Db = openDb(':memory:');
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 999);
    const createWorktreeFromBranch = vi.fn(async (_repo: string, _runId: string, _branch: string) => ({ path: '/tmp/wt-review', branch: 'fix/x' }));
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 12, review: true };
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'done' }], true), freshRunsDir()),
      createWorktreeFromBranch,
      jira,
      botAccountId: 'bot-acc',
      findPrNumber,
    };

    const id = await startRun(reviewTask, d);

    expect(jira.assignCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
    expect(findPrNumber).not.toHaveBeenCalled();
    expect(db.getRun(id)?.prNumber).toBe(12);
    db.close();
  });

  it('publishes a single run-complete event with the final status, after the run row is already terminal, on failure', async () => {
    const db: Db = openDb(':memory:');
    const d: RunnerDeps = deps(db, jsonAdapter(), singleAttemptHost([{ kind: 'result', text: 'nope' }], false), freshRunsDir());
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

describe('reattachRun', () => {
  function baseRow(runsDir: string): RunRow {
    return {
      id: 'run-1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'fake', status: 'running', attempt: 1,
      prNumber: null, startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null,
      worktreePath: '/tmp/wt', logPath: join(runsDir, 'run-1.log'), exitPath: join(runsDir, 'run-1.exit'),
      specPath: join(runsDir, 'run-1.json'), logOffset: 0, taskJson: JSON.stringify(task),
      hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 1 }),
    };
  }

  it('finalizes to the stored exit code status when the exit file is already present', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    writeFileSync(row.logPath!, JSON.stringify({ kind: 'result', text: 'done', prNumber: 7, costUsd: 0.2 }) + '\n');
    writeFileSync(row.exitPath!, '0');
    db.insertRun(row);
    const d = deps(db, jsonAdapter(), fakeHost(() => ({ events: [], ok: true })), runsDir);

    await reattachRun(row, d);

    const updated = db.getRun('run-1');
    expect(updated?.status).toBe('succeeded');
    expect(updated?.prNumber).toBe(7);
    expect(updated?.costUsd).toBeCloseTo(0.2);
    expect(d.removeWorktree).toHaveBeenCalledOnce();
    db.close();
  });

  it('tails remaining log and awaits the exit file when the host is still alive, then finalizes', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    writeFileSync(row.logPath!, JSON.stringify({ kind: 'phase', text: 'before crash' }) + '\n');
    db.insertRun(row);
    const host: RunHost = {
      kind: 'detached',
      launch: vi.fn(),
      async isAlive(): Promise<boolean> { return true; },
      async stop(): Promise<void> { return undefined; },
    };
    const d = deps(db, jsonAdapter(), host, runsDir);

    setTimeout(() => {
      appendFileSync(row.logPath!, JSON.stringify({ kind: 'result', text: 'done', prNumber: 9, costUsd: 0.3 }) + '\n');
      writeFileSync(row.exitPath!, '0');
    }, 20);

    await reattachRun(row, d);

    const updated = db.getRun('run-1');
    expect(updated?.status).toBe('succeeded');
    expect(updated?.prNumber).toBe(9);
    expect(updated?.costUsd).toBeCloseTo(0.3);
    expect(db.listEvents('run-1').some((e) => e.text === 'before crash')).toBe(true);
    db.close();
  });

  it('finalizes as failed with an interrupted error event when the host is dead and no exit file exists', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    db.insertRun(row);
    const host: RunHost = {
      kind: 'detached',
      launch: vi.fn(),
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const d = deps(db, jsonAdapter(), host, runsDir);

    await reattachRun(row, d);

    const updated = db.getRun('run-1');
    expect(updated?.status).toBe('failed');
    expect(d.removeWorktree).toHaveBeenCalledWith('o/r', '/tmp/wt');
    expect(db.listEvents('run-1').some((e) => e.kind === 'error' && e.text.includes('host gone'))).toBe(true);
    db.close();
  });
});
