import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Db, type RunRow } from './db';

let db: Db;
afterEach(() => db?.close());

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'claude-code',
    status: 'running', attempt: 1, prNumber: null,
    startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: '/tmp/w',
    hostKind: null, hostRef: null, logPath: null, exitPath: null, specPath: null, logOffset: null, taskJson: null,
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

  it('lists runs newest-first and respects limit', () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'r1', startedAt: '2026-08-18T00:00:00.000Z' }));
    db.insertRun(run({ id: 'r2', startedAt: '2026-08-18T00:00:02.000Z' }));
    db.insertRun(run({ id: 'r3', startedAt: '2026-08-18T00:00:01.000Z' }));
    const all: string[] = db.listRuns(10).map((r) => r.id);
    expect(all).toEqual(['r2', 'r3', 'r1']);
    const limited: string[] = db.listRuns(2).map((r) => r.id);
    expect(limited).toEqual(['r2', 'r3']);
  });

  it('updateRun with empty patch is a no-op', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    const before: RunRow | null = db.getRun('r1');
    db.updateRun('r1', {});
    const after: RunRow | null = db.getRun('r1');
    expect(after).toEqual(before);
  });

  it('migrates: adds durable-run columns to a pre-existing runs table and round-trips them', () => {
    const path = join(tmpdir(), `gm-mig-${Math.random().toString(36).slice(2)}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT, attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT);`);
    legacy.prepare(`INSERT INTO runs (id,ticketId,repo,adapter,status,attempt,prNumber,startedAt,endedAt,costUsd,worktreePath) VALUES ('old','T-1','o/r','codex','running',1,null,'t',null,null,null)`).run();
    legacy.close();

    db = openDb(path);
    db.updateRun('old', { hostKind: 'detached', hostRef: '{"kind":"detached","pid":9}', logPath: '/l', exitPath: '/e', specPath: '/s', logOffset: 42, taskJson: '{"ticketId":"T-1"}' });
    const row = db.getRun('old')!;
    expect(row.hostKind).toBe('detached');
    expect(row.logOffset).toBe(42);
    expect(db.reattachableRuns().map((r) => r.id)).toContain('old');
    db.close();
  });
});
