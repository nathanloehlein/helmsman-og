import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { recoverRuns } from './recovery';
import { ProcessManager } from './process-manager';
import { restoredResources } from './run-reservations';

let db: Db;
afterEach(() => db?.close());

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'claude-code',
    status: 'running', attempt: 1, prNumber: null,
    startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: '/tmp/w',
    hostRef: 'host-1', logPath: '/tmp/w/log.txt', exitPath: '/tmp/w/exit.json',
    taskJson: '{"ticketId":"LEKA-1"}',
    ...over,
  };
}

describe('recoverRuns', () => {
  it('restores branch reservations synchronously while keeping missing-metadata PRs exclusive', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'writer', taskJson: JSON.stringify({ ticketId: 'LEKA-1', prBranch: 'feature' }) }));
    db.insertRun(run({ id: 'legacy-review', ticketId: 'review', prNumber: 42, taskJson: null }));
    const pm = new ProcessManager(3);
    await recoverRuns(db, { reattach: row => {
      pm.restore(row.id, row.repo, () => undefined, restoredResources(row));
      return new Promise<void>(() => {});
    } });
    expect(pm.count()).toBe(2);
    expect(pm.canStart('o/r', { branch: 'feature' }).ok).toBe(false);
    expect(pm.canStart('o/r', { prNumber: 42 }).ok).toBe(false);
    expect(pm.canStart('o/r', { ticketId: 'OTHER-1', branch: 'agent/new' }).ok).toBe(true);
  });

  it('dispatches each running row to reattach instead of failing it, without awaiting completion', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));
    db.insertRun(run({ id: 'c', status: 'succeeded', endedAt: '2026-08-17T00:00:00.000Z' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: (row) => {
        seen.push(row.id);
        return new Promise<void>(() => {});
      },
    });

    expect(new Set(seen)).toEqual(new Set(['a', 'b']));
    expect(new Set(res.reattached)).toEqual(new Set(['a', 'b']));
    expect(res.failed).toEqual([]);

    const a: RunRow | null = db.getRun('a');
    const b: RunRow | null = db.getRun('b');
    expect(a?.status).toBe('running');
    expect(b?.status).toBe('running');

    const c: RunRow | null = db.getRun('c');
    expect(c?.status).toBe('succeeded');
  });

  it('dispatches every row even when one reattach rejects', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: async (row) => {
        seen.push(row.id);
        if (row.id === 'a') throw new Error('boom');
      },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(res.reattached).toEqual(['a', 'b']);
    expect(res.failed).toEqual([]);
  });

  it('keeps dispatching remaining rows when one reattach throws synchronously', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, {
      reattach: (row) => {
        seen.push(row.id);
        if (row.id === 'a') throw new Error('boom');
        return Promise.resolve();
      },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(res.reattached).toEqual(['b']);
    expect(res.failed).toEqual([]);
  });

  it('returns empty results when there are no reattachable runs', async () => {
    db = openDb(':memory:');
    const res = await recoverRuns(db, { reattach: async () => {} });
    expect(res).toEqual({ reattached: [], failed: [] });
  });
});
