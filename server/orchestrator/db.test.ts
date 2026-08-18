import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';

let db: Db;
afterEach(() => db?.close());

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'claude-code',
    status: 'running', attempt: 1, prNumber: null,
    startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: '/tmp/w',
    ...over,
  };
}

describe('db', () => {
  it('inserts and reads a run', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    expect(db.getRun('r1')?.ticketId).toBe('LEKA-1');
    expect(db.getRun('missing')).toBeNull();
  });

  it('patches a run', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    db.updateRun('r1', { status: 'succeeded', prNumber: 42, endedAt: '2026-08-18T01:00:00.000Z', costUsd: 1.5 });
    const r = db.getRun('r1');
    expect(r?.status).toBe('succeeded');
    expect(r?.prNumber).toBe(42);
    expect(r?.costUsd).toBe(1.5);
  });

  it('lists active runs only', () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a', status: 'running' }));
    db.insertRun(run({ id: 'b', status: 'succeeded' }));
    expect(db.activeRuns().map((r) => r.id)).toEqual(['a']);
  });

  it('appends and lists events in order', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    db.appendEvent('r1', 'phase', 'claimed', '2026-08-18T00:00:01.000Z');
    db.appendEvent('r1', 'log', 'working', '2026-08-18T00:00:02.000Z');
    const evs = db.listEvents('r1');
    expect(evs.map((e) => e.text)).toEqual(['claimed', 'working']);
    expect(evs[0].kind).toBe('phase');
  });
});
