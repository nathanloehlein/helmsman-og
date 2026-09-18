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
const unknownAttribution = { role: 'review agent', model: 'not reported', effort: 'not reported' };
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
  it('preserves a failed pre-PR worktree and reports its location without queuing publication side effects', async () => {
    const db = openDb(':memory:');
    try {
      const enqueueCreatedPrReview = vi.fn();
      const d = { ...deps(db, jsonAdapter('pre-pr:codex'), singleAttemptHost([{ kind: 'error', text: 'Unresolved findings' }], false), freshRunsDir()),
        preserveWorktreeOnFailure: true, enqueueCreatedPrReview };
      const id = await startRun(task, d);
      expect(db.getRun(id)?.status).toBe('failed');
      expect(d.removeWorktree).not.toHaveBeenCalled();
      expect(enqueueCreatedPrReview).not.toHaveBeenCalled();
      expect(db.listEvents(id).some(event => event.text === 'Worktree retained for inspection: /tmp/wt')).toBe(true);
    } finally { db.close(); }
  });

  it('cleans up a published pre-PR worktree and queues the existing post-publication review', async () => {
    const db = openDb(':memory:');
    try {
      const enqueueCreatedPrReview = vi.fn();
      const d = { ...deps(db, jsonAdapter('pre-pr:codex'), singleAttemptHost([], true, 42), freshRunsDir()),
        preserveWorktreeOnFailure: true, enqueueCreatedPrReview };
      await startRun(task, d);
      expect(d.removeWorktree).toHaveBeenCalledWith('o/r', '/tmp/wt');
      expect(enqueueCreatedPrReview).toHaveBeenCalledWith({ parentRunId: 'run-1', repo: 'o/r', prNumber: 42 });
    } finally { db.close(); }
  });

  it('pins review worktrees and persists model selection in task metadata and phase events', async () => {
    const db = openDb(':memory:');
    try {
      const headSha = 'a'.repeat(40);
      const reviewTask: AgentTask = {
        ...task, ticketId: 'review', review: true, prNumber: 42, prBranch: 'feature', prHeadSha: headSha,
        model: 'gpt-5.6-terra', effort: 'low', reviewComplexity: 'low', reviewReason: 'One small file',
      };
      const createReviewWorktree = vi.fn(async () => ({ path: '/tmp/pinned-review', branch: headSha }));
      const createWorktreeFromBranch = vi.fn(async () => ({ path: '/tmp/branch-review', branch: 'feature' }));
      const d: RunnerDeps = {
        ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()),
        createReviewWorktree, createWorktreeFromBranch,
        readReview: async () => 'Verdict: APPROVE — Looks good',
        postReview: async () => ({ ok: true }),
      };
      const events: AgentEvent[] = [];
      d.bus.subscribe('run-1', event => events.push(event));
      await startRun(reviewTask, d);
      expect(createReviewWorktree).toHaveBeenCalledWith('o/r', 'run-1', 42, headSha);
      expect(createWorktreeFromBranch).not.toHaveBeenCalled();
      const row = db.getRun('run-1');
      expect(row?.status).toBe('succeeded');
      expect(JSON.parse(row?.taskJson ?? '{}')).toMatchObject({ prHeadSha: headSha, model: 'gpt-5.6-terra', effort: 'low', reviewComplexity: 'low', reviewReason: 'One small file' });
      const phase = { kind: 'phase', text: 'Review complexity: low; model: gpt-5.6-terra; effort: low. One small file' };
      expect(events).toContainEqual(phase);
      expect(db.listEvents('run-1')).toContainEqual(expect.objectContaining(phase));
    } finally { db.close(); }
  });

  it('fails pinned reviews before launching if the pinned checkout dependency is absent', async () => {
    const db = openDb(':memory:');
    try {
      const host = singleAttemptHost([], true);
      const launch = vi.spyOn(host, 'launch');
      const createWorktreeFromBranch = vi.fn(async () => ({ path: '/tmp/branch-review', branch: 'feature' }));
      const d = { ...deps(db, jsonAdapter(), host, freshRunsDir()), createWorktreeFromBranch };
      await startRun({ ...task, review: true, prNumber: 42, prBranch: 'feature', prHeadSha: 'a'.repeat(40) }, d);
      expect(db.getRun('run-1')?.status).toBe('failed');
      expect(db.listEvents('run-1')).toContainEqual(expect.objectContaining({ kind: 'error', text: 'pinned review requires createReviewWorktree and a PR number' }));
      expect(createWorktreeFromBranch).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

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

  it('fails with "adapter produced no command" and never launches the host when buildCommand returns an empty cmd', async () => {
    const db: Db = openDb(':memory:');
    const emptyCmdAdapter: AgentAdapter = {
      id: 'empty',
      buildCommand(): { cmd: string; args: string[] } {
        return { cmd: '', args: [] };
      },
      parseLine(): AgentEvent | null {
        return null;
      },
    };
    const launch = vi.fn(async (): Promise<HostRef> => ({ kind: 'detached', pid: 1 }));
    const host: RunHost = {
      kind: 'detached',
      launch,
      async isAlive(): Promise<boolean> { return false; },
      async stop(): Promise<void> { return undefined; },
    };
    const id = await startRun(task, deps(db, emptyCmdAdapter, host, freshRunsDir()));

    const row = db.getRun(id);
    expect(row?.status).toBe('failed');
    expect(launch).not.toHaveBeenCalled();
    expect(db.listEvents(id).some((e) => e.kind === 'error' && e.text === 'adapter produced no command')).toBe(true);
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

  it('persists the target prNumber on a failed review run so the recent-runs row still links the PR', async () => {
    const db: Db = openDb(':memory:');
    const reviewTask: AgentTask = { ticketId: 'review', title: '', repo: 'o/r', jiraBaseUrl: '', prBranch: 'fix/x', prNumber: 4310, review: true };
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()), createWorktree: async () => { throw new Error('git fail'); } };
    const id = await startRun(reviewTask, d);
    const row = db.getRun(id);
    expect(row?.status).toBe('failed');
    expect(row?.prNumber).toBe(4310);
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

  it.each([['ticket', task], ['freeform', freeformTask]] as const)('queues an own review before completing a %s run and requesting Copilot', async (_label, codingTask) => {
    const db = openDb(':memory:');
    const enqueueCreatedPrReview = vi.fn(({ parentRunId }: { parentRunId: string }) => {
      expect(db.getRun(parentRunId)?.status).toBe('running');
    });
    const requestCopilotReview = vi.fn(async () => {
      expect(enqueueCreatedPrReview).toHaveBeenCalledOnce();
      return { ok: true as const };
    });
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([], true, 42), freshRunsDir()),
      enqueueCreatedPrReview, requestCopilotReview,
    };

    const id = await startRun(codingTask, d);

    expect(enqueueCreatedPrReview).toHaveBeenCalledExactlyOnceWith({ parentRunId: id, repo: 'o/r', prNumber: 42 });
    expect(db.getRun(id)?.status).toBe('succeeded');
    expect(db.listEvents(id)).toContainEqual(expect.objectContaining({ kind: 'log', text: 'Queued Helmsman review for PR #42' }));
    expect(requestCopilotReview).toHaveBeenCalledOnce();
    db.close();
  });

  it.each([
    { label: 'rerun', input: { ...freeformTask, prBranch: 'fix/x', prNumber: 42 }, ok: true, stopped: false, prNumber: 42 },
    { label: 'review', input: { ...task, review: true, prNumber: 42 }, ok: true, stopped: false, prNumber: 42 },
    { label: 'failed', input: task, ok: false, stopped: false, prNumber: 42 },
    { label: 'stopped', input: task, ok: true, stopped: true, prNumber: 42 },
    { label: 'without PR', input: task, ok: true, stopped: false, prNumber: undefined },
  ])('does not queue an own review for a $label run', async ({ input, ok, stopped, prNumber }) => {
    const db = openDb(':memory:');
    const enqueueCreatedPrReview = vi.fn();
    const requestCopilotReview = vi.fn(async () => ({ ok: true as const }));
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([], ok, prNumber), freshRunsDir()),
      createWorktreeFromBranch: async () => ({ path: '/tmp/wt', branch: 'fix/x' }),
      enqueueCreatedPrReview, requestCopilotReview, isStopped: () => stopped,
    };

    const id = await startRun(input, d);

    expect(enqueueCreatedPrReview).not.toHaveBeenCalled();
    expect(requestCopilotReview).not.toHaveBeenCalled();
    if (stopped) expect(db.getRun(id)?.status).toBe('stopped');
    db.close();
  });

  it.each(['enqueue', 'copilot'] as const)('keeps a successful coding run succeeded when %s throws', async (failure) => {
    const db = openDb(':memory:');
    const enqueueCreatedPrReview = vi.fn(() => {
      if (failure === 'enqueue') throw new Error('queue unavailable');
    });
    const requestCopilotReview = vi.fn(async () => {
      if (failure === 'copilot') throw new Error('GitHub unavailable');
      return { ok: true as const };
    });
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([], true, 42), freshRunsDir()),
      enqueueCreatedPrReview, requestCopilotReview,
    };

    const id = await startRun(task, d);

    expect(db.getRun(id)?.status).toBe('succeeded');
    expect(enqueueCreatedPrReview).toHaveBeenCalledOnce();
    expect(requestCopilotReview).toHaveBeenCalledOnce();
    expect(db.listEvents(id)).toContainEqual(expect.objectContaining({
      kind: failure === 'enqueue' ? 'error' : 'log',
      text: failure === 'enqueue'
        ? 'Queuing Helmsman review for PR #42 failed: queue unavailable'
        : 'requesting Copilot review failed (non-fatal): GitHub unavailable',
    }));
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

  it('never writes Jira for a persisted local source even without task text', async () => {
    const db = openDb(':memory:');
    try {
      const jira = fakeJira();
      const d = { ...deps(db, jsonAdapter(), singleAttemptHost([], true, 42), freshRunsDir()), jira, botAccountId: 'bot' };
      await startRun({ ...task, todoId: 'TODO-1', ticketId: 'TODO-1' }, d);
      expect(db.getRun('run-1')?.status).toBe('succeeded');
      expect(jira.assignCalls).toEqual([]);
      expect(jira.transitionCalls).toEqual([]);
    } finally { db.close(); }
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
    expect(postReview).toHaveBeenCalledWith('o/r', 12, '## Review\nlooks fine', { headSha: undefined, comments: [], attribution: unknownAttribution });
    expect(readReview.mock.invocationCallOrder[0]).toBeLessThan(removeWorktree.mock.invocationCallOrder[0]);
    expect(events.some((e) => e.kind === 'log' && e.text.includes('posted code-review comment on PR #12'))).toBe(true);
    db.close();
  });

  it('submits inline findings and the pinned revision with the summary before cleanup', async () => {
    const db = openDb(':memory:');
    try {
      const headSha = 'a'.repeat(40);
      const comments = [{ path: 'src/value.ts', line: 12, side: 'RIGHT', body: 'Handle missing input.\n\n```suggestion\nreturn value ?? 0;\n```' }];
      const postReview = vi.fn(async () => ({ ok: true as const }));
      const removeWorktree = vi.fn(async () => undefined);
      const d: RunnerDeps = {
        ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()),
        createReviewWorktree: async () => ({ path: '/tmp/inline-review', branch: headSha }),
        readReview: async () => 'Verdict: REQUEST_CHANGES — Handle missing input.',
        readReviewComments: async () => JSON.stringify(comments),
        postReview, removeWorktree,
      };
      await startRun({ ...task, review: true, prNumber: 12, prHeadSha: headSha }, d);
      expect(postReview).toHaveBeenCalledWith('o/r', 12, 'Verdict: REQUEST_CHANGES — Handle missing input.', { headSha, comments, attribution: unknownAttribution });
      expect(postReview.mock.invocationCallOrder[0]).toBeLessThan(removeWorktree.mock.invocationCallOrder[0]);
      expect(db.getRun('run-1')?.status).toBe('succeeded');
    } finally { db.close(); }
  });

  it.each([
    { adapter: 'codex', model: undefined, effort: undefined, expectedModel: 'gpt-6-astra', expectedEffort: 'medium' },
    { adapter: 'codex', model: 'gpt-5.5', effort: 'high', expectedModel: 'gpt-5.5', expectedEffort: 'high' },
    { adapter: 'claude-code', model: 'sonnet', effort: 'low', expectedModel: 'sonnet', expectedEffort: 'low' },
  ])('passes effective $adapter model $expectedModel and effort $expectedEffort without modifying verdict text', async ({ adapter, model, effort, expectedModel, expectedEffort }) => {
    const db = openDb(':memory:');
    try {
      const body = 'Verdict: APPROVE — Looks good.';
      const postReview = vi.fn(async () => ({ ok: true as const }));
      const d: RunnerDeps = {
        ...deps(db, jsonAdapter(adapter), singleAttemptHost([], true), freshRunsDir()),
        createWorktreeFromBranch: async () => ({ path: '/tmp/attributed-review', branch: 'fix/x' }),
        readReview: async () => body,
        postReview,
      };
      await startRun({ ...task, review: true, prNumber: 12, prBranch: 'fix/x', model, effort }, d);
      expect(postReview).toHaveBeenCalledExactlyOnceWith('o/r', 12, body, {
        headSha: undefined,
        comments: [],
        attribution: { role: 'review agent', model: expectedModel, effort: expectedEffort },
      });
      expect(db.listEvents('run-1').find(event => event.kind === 'review-verdict')?.text).toBe('Verdict: Approve — Looks good.');
    } finally { db.close(); }
  });

  it.each(['invalid JSON', JSON.stringify([{ path: 'a.ts', line: null, side: 'RIGHT', body: 'Finding' }])])('fails malformed inline output without publishing a misleading summary: %s', async (raw) => {
    const db = openDb(':memory:');
    try {
      const postReview = vi.fn(async () => ({ ok: true as const }));
      const d: RunnerDeps = {
        ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()),
        createWorktreeFromBranch: async () => ({ path: '/tmp/inline-review', branch: 'fix/x' }),
        readReview: async () => 'Verdict: REQUEST_CHANGES — See inline findings.',
        readReviewComments: async () => raw, postReview,
      };
      await startRun({ ...task, review: true, prNumber: 12, prBranch: 'fix/x' }, d);
      expect(postReview).not.toHaveBeenCalled();
      expect(db.getRun('run-1')?.status).toBe('failed');
      expect(db.listEvents('run-1').some(event => event.kind === 'review-verdict')).toBe(false);
    } finally { db.close(); }
  });

  it('publishes legacy summary-only output when no inline sidecar exists', async () => {
    const db = openDb(':memory:');
    try {
      const postReview = vi.fn(async () => ({ ok: true as const }));
      const d: RunnerDeps = {
        ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()),
        createWorktreeFromBranch: async () => ({ path: '/tmp/inline-review', branch: 'fix/x' }),
        readReview: async () => 'Verdict: APPROVE — Looks good.',
        readReviewComments: async () => null, postReview,
      };
      await startRun({ ...task, review: true, prNumber: 12, prBranch: 'fix/x' }, d);
      expect(postReview).toHaveBeenCalledWith('o/r', 12, 'Verdict: APPROVE — Looks good.', { headSha: undefined, comments: [], attribution: unknownAttribution });
      expect(db.getRun('run-1')?.status).toBe('succeeded');
    } finally { db.close(); }
  });

  it.each([
    ['APPROVE', 'Approve', 'No blocking issues found.'],
    ['REQUEST_CHANGES', 'Request changes', 'Fallback handling drops valid outcomes.'],
    ['COMMENT', 'Comment only', 'Only minor naming suggestions.'],
  ])('persists and publishes %s immediately before success', async (verdict, label, reason) => {
    const db = openDb(':memory:');
    const body = `Verdict: ${verdict} — ${reason}\n\nFull review findings.`;
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([], true), freshRunsDir()),
      createWorktreeFromBranch: async () => ({ path: '/tmp/wt-review', branch: 'fix/x' }),
      readReview: async () => body,
      postReview: vi.fn(async () => ({ ok: true as const })),
    };
    const events: AgentEvent[] = [];
    d.bus.subscribe('run-1', event => events.push(event));
    await startRun({ ...task, ticketId: 'review', prBranch: 'fix/x', prNumber: 12, review: true }, d);
    const expected = [
      { kind: 'review-verdict', text: `Verdict: ${label} — ${reason}` },
      { kind: 'run-complete', text: 'succeeded' },
    ];
    expect(events.slice(-2)).toEqual(expected);
    expect(db.listEvents('run-1').slice(-2).map(({ kind, text }) => ({ kind, text }))).toEqual(expected);
    expect(d.postReview).toHaveBeenCalledWith('o/r', 12, body, { headSha: undefined, comments: [], attribution: unknownAttribution });
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
    expect(events.some((e) => e.kind === 'review-verdict')).toBe(false);
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
    expect(events.some((e) => e.kind === 'review-verdict')).toBe(false);
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

    expect(postReview).toHaveBeenCalledWith('o/r', 12, '## Review\nfindings', { headSha: undefined, comments: [], attribution: unknownAttribution });
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

  it('retains failed gated work after recovery without relaunching the author', async () => {
    const db = openDb(':memory:');
    try {
      const runsDir = freshRunsDir();
      const row = { ...baseRow(runsDir), adapter: 'pre-pr:codex' };
      writeFileSync(row.logPath!, JSON.stringify({ kind: 'error', text: 'Review did not complete' }) + '\n');
      writeFileSync(row.exitPath!, '1');
      db.insertRun(row);
      const host = fakeHost(() => ({ events: [], ok: true }));
      const launch = vi.spyOn(host, 'launch');
      const d = { ...deps(db, jsonAdapter('pre-pr:codex'), host, runsDir), preserveWorktreeOnFailure: true };
      await reattachRun(row, d);
      expect(db.getRun(row.id)?.status).toBe('failed');
      expect(d.removeWorktree).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(db.listEvents(row.id).some(event => event.text.includes('Worktree retained'))).toBe(true);
    } finally { db.close(); }
  });

  it('finalizes to the stored exit code status when the exit file is already present', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    writeFileSync(row.logPath!, JSON.stringify({ kind: 'result', text: 'done', prNumber: 7, costUsd: 0.2 }) + '\n');
    writeFileSync(row.exitPath!, '0');
    db.insertRun(row);
    const d = deps(db, jsonAdapter(), fakeHost(() => ({ events: [], ok: true })), runsDir);
    d.enqueueCreatedPrReview = vi.fn();

    await reattachRun(row, d);

    const updated = db.getRun('run-1');
    expect(updated?.status).toBe('succeeded');
    expect(updated?.prNumber).toBe(7);
    expect(updated?.costUsd).toBeCloseTo(0.2);
    expect(d.enqueueCreatedPrReview).toHaveBeenCalledExactlyOnceWith({ parentRunId: row.id, repo: 'o/r', prNumber: 7 });
    expect(d.removeWorktree).toHaveBeenCalledOnce();
    db.close();
  });

  it('keeps the verdict before completion after reattaching a review', async () => {
    const db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = { ...baseRow(runsDir), prNumber: 12, taskJson: JSON.stringify({ ...task, prNumber: 12, prBranch: 'fix/x', review: true }) };
    writeFileSync(row.logPath!, '');
    writeFileSync(row.exitPath!, '0');
    db.insertRun(row);
    const d: RunnerDeps = {
      ...deps(db, jsonAdapter(), singleAttemptHost([], true), runsDir),
      readReview: async () => 'Verdict: REQUEST_CHANGES — Missing error handling.',
      postReview: async () => ({ ok: true }),
    };
    await reattachRun(row, d);
    expect(db.listEvents(row.id).slice(-2).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'review-verdict', text: 'Verdict: Request changes — Missing error handling.' },
      { kind: 'run-complete', text: 'succeeded' },
    ]);
    db.close();
  });

  it('reattaches reviews with attribution from the persisted execution settings', async () => {
    const db = openDb(':memory:');
    try {
      const runsDir = freshRunsDir();
      const row = {
        ...baseRow(runsDir), adapter: 'codex', prNumber: 12,
        taskJson: JSON.stringify({ ...task, prNumber: 12, prBranch: 'fix/x', review: true, model: 'gpt-5.5', effort: 'xhigh' }),
      };
      writeFileSync(row.logPath!, '');
      writeFileSync(row.exitPath!, '0');
      db.insertRun(row);
      const postReview = vi.fn(async () => ({ ok: true as const }));
      await reattachRun(row, {
        ...deps(db, jsonAdapter(row.adapter), singleAttemptHost([], true), runsDir),
        readReview: async () => 'Verdict: COMMENT — Naming suggestion.',
        postReview,
      });
      expect(postReview).toHaveBeenCalledExactlyOnceWith('o/r', 12, 'Verdict: COMMENT — Naming suggestion.', {
        headSha: undefined,
        comments: [],
        attribution: { role: 'review agent', model: 'gpt-5.5', effort: 'xhigh' },
      });
      expect(db.getRun(row.id)?.status).toBe('succeeded');
    } finally { db.close(); }
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

  it('resumes from a non-zero logOffset and only replays lines not yet consumed', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    const firstLine = JSON.stringify({ kind: 'phase', text: 'already seen' }) + '\n';
    const secondLine = JSON.stringify({ kind: 'result', text: 'done', prNumber: 11, costUsd: 0.4 }) + '\n';
    writeFileSync(row.logPath!, firstLine + secondLine);
    writeFileSync(row.exitPath!, '0');
    row.logOffset = Buffer.byteLength(firstLine, 'utf8');
    db.insertRun(row);
    const d = deps(db, jsonAdapter(), fakeHost(() => ({ events: [], ok: true })), runsDir);

    const events: AgentEvent[] = [];
    d.bus.subscribe('run-1', (e: AgentEvent): void => { events.push(e); });

    await reattachRun(row, d);

    expect(events.some((e) => e.text === 'already seen')).toBe(false);
    expect(events.some((e) => e.text === 'done')).toBe(true);
    const updated = db.getRun('run-1');
    expect(updated?.prNumber).toBe(11);
    expect(updated?.costUsd).toBeCloseTo(0.4);
    db.close();
  });

  it('never transitions Jira for a local task recovered after Jira is reenabled', async () => {
    const db = openDb(':memory:');
    try {
      const runsDir = freshRunsDir();
      const row = { ...baseRow(runsDir), prNumber: 7, taskJson: JSON.stringify({ ...task, todoId: 'TODO-1', ticketId: 'TODO-1' }) };
      writeFileSync(row.exitPath!, '0');
      db.insertRun(row);
      const jira = fakeJira();
      await reattachRun(row, { ...deps(db, jsonAdapter(), singleAttemptHost([], true), runsDir), jira, botAccountId: 'bot' });
      expect(db.getRun(row.id)?.status).toBe('succeeded');
      expect(jira.assignCalls).toEqual([]);
      expect(jira.transitionCalls).toEqual([]);
    } finally { db.close(); }
  });

  it('finalizes with markInReview when the PR number was already persisted pre-crash', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    row.prNumber = 7;
    writeFileSync(row.logPath!, JSON.stringify({ kind: 'result', text: 'done' }) + '\n');
    writeFileSync(row.exitPath!, '0');
    db.insertRun(row);
    const jira = fakeJira();
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), fakeHost(() => ({ events: [], ok: true })), runsDir), jira, botAccountId: 'bot-acc' };

    await reattachRun(row, d);

    const updated = db.getRun('run-1');
    expect(updated?.status).toBe('succeeded');
    expect(updated?.prNumber).toBe(7);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
    db.close();
  });

  it('falls back to findPrNumber when a reattached run finalizes successfully with no PR number', async () => {
    const db: Db = openDb(':memory:');
    const runsDir = freshRunsDir();
    const row = baseRow(runsDir);
    writeFileSync(row.logPath!, JSON.stringify({ kind: 'result', text: 'done' }) + '\n');
    writeFileSync(row.exitPath!, '0');
    db.insertRun(row);
    const jira = fakeJira();
    const findPrNumber = vi.fn(async (_repo: string, _branch: string) => 55);
    const d: RunnerDeps = { ...deps(db, jsonAdapter(), fakeHost(() => ({ events: [], ok: true })), runsDir), jira, botAccountId: 'bot-acc', findPrNumber };

    await reattachRun(row, d);

    expect(findPrNumber).toHaveBeenCalledWith('o/r', `agent/${row.id}`);
    const updated = db.getRun('run-1');
    expect(updated?.prNumber).toBe(55);
    expect(jira.transitionCalls).toContainEqual({ ticketId: 'LEKA-1', statusName: 'In Review' });
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
