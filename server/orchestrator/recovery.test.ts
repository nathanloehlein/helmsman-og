import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { recoverRuns } from './recovery';

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
  it('dispatches each running row to reattach instead of failing it', async () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a' }));
    db.insertRun(run({ id: 'b' }));
    db.insertRun(run({ id: 'c', status: 'succeeded', endedAt: '2026-08-17T00:00:00.000Z' }));

    const seen: string[] = [];
    const res = await recoverRuns(db, { reattach: async (row) => { seen.push(row.id); } });

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

  it('keeps dispatching remaining rows when one reattach throws', async () => {
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

    expect(new Set(seen)).toEqual(new Set(['a', 'b']));
    expect(res.reattached).toEqual(['b']);
    expect(res.failed).toEqual([]);
  });

  it('returns empty results when there are no reattachable runs', async () => {
    db = openDb(':memory:');
    const res = await recoverRuns(db, { reattach: async () => {} });
    expect(res).toEqual({ reattached: [], failed: [] });
  });
});
