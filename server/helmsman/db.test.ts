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

  it('bounds recent replay while retaining complete paginated events', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    db.appendEvent('r1', 'log', 'first complete output', 't1');
    db.appendEvent('other', 'log', 'other run', 't2');
    const middle = db.appendEvent('r1', 'log', 'middle complete output', 't3');
    const last = db.appendEvent('r1', 'log', 'last complete output', 't4');
    expect(db.recentEvents('r1', 2, 6).map((event) => event.text)).toEqual(['middle', 'last c']);
    expect(db.eventPage('r1', 0, last.id, 1).map((event) => event.text)).toEqual(['first complete output']);
    expect(db.eventPage('r1', middle.id, last.id, 10).map((event) => event.text)).toEqual(['last complete output']);
    db.appendEvent('r1', 'log', 'later output', 't5');
    expect(db.eventPage('r1', middle.id, last.id, 10)).toHaveLength(1);
    expect(db.recentEvents('missing', 300, 4000)).toEqual([]);
  });

  it('paginates the complete history with deterministic ordering and matching repository totals', () => {
    db = openDb(':memory:');
    for (let index = 0; index < 60; index++) {
      db.insertRun(run({ id: `run-${String(index).padStart(2, '0')}`, repo: index % 2 ? 'owner/repo' : 'other/repo' }));
    }
    const first = db.runPage(25, 0);
    const second = db.runPage(25, 25);
    const third = db.runPage(25, 50);
    expect(first.total).toBe(60);
    expect(first.runs[0]?.id).toBe('run-59');
    expect(third.runs).toHaveLength(10);
    expect(new Set([...first.runs, ...second.runs, ...third.runs].map(({ id }) => id)).size).toBe(60);
    expect(db.runPage(25, 100)).toEqual({ runs: [], total: 60 });
    const filtered = db.runPage(25, 25, 'OWNER/REPO');
    expect(filtered.total).toBe(30);
    expect(filtered.runs.map(({ id }) => id)).toEqual(['run-09', 'run-07', 'run-05', 'run-03', 'run-01']);
    expect(db.runPage(25, 0, 'missing/repo')).toEqual({ runs: [], total: 0 });
  });

  it.each([[0, 0], [101, 0], [1.5, 0], [25, -1], [25, Infinity], [NaN, 0]])('rejects invalid history bounds %s/%s', (limit, offset) => {
    db = openDb(':memory:');
    expect(() => db.runPage(limit, offset)).toThrow(RangeError);
  });

  it('reads only the latest review verdict for the matching run and bounds its text', () => {
    db = openDb(':memory:');
    expect(db.latestReviewVerdict('r1')).toBeNull();
    db.appendEvent('r1', 'review-verdict', 'Verdict: Approve — Ready.', 't3');
    db.appendEvent('r1', 'review-verdict', 'Verdict: Request changes — Logic flaw.', 't1');
    db.appendEvent('other', 'review-verdict', 'Verdict: Comment only — Unverified.', 't4');
    db.appendEvent('r1', 'log', 'Verdict: Approve — Ignore log output.', 't5');
    expect(db.latestReviewVerdict('r1')).toBe('Verdict: Request changes — Logic flaw.');
    expect(db.latestReviewVerdict('missing')).toBeNull();
    db.appendEvent('r1', 'review-verdict', 'x'.repeat(10000), 't6');
    expect(db.latestReviewVerdict('r1')).toBe('x'.repeat(512));
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
    const path = join(tmpdir(), `helmsman-mig-${Math.random().toString(36).slice(2)}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT, attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT);`);
    legacy.exec(`CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, ts TEXT, kind TEXT, text TEXT);`);
    legacy.prepare('INSERT INTO run_events (runId, ts, kind, text) VALUES (?, ?, ?, ?)').run('old', 't', 'review-verdict', 'Verdict: Approve — Ready.');
    legacy.prepare(`INSERT INTO runs (id,ticketId,repo,adapter,status,attempt,prNumber,startedAt,endedAt,costUsd,worktreePath) VALUES ('old','T-1','o/r','codex','running',1,null,'t',null,null,null)`).run();
    legacy.close();

    db = openDb(path);
    expect(db.latestReviewVerdict('old')).toBe('Verdict: Approve — Ready.');
    const migrated = new Database(path);
    const plan = migrated.prepare("EXPLAIN QUERY PLAN SELECT text FROM run_events WHERE runId = ? AND kind = 'review-verdict' ORDER BY id DESC LIMIT 1").all('old') as { detail: string }[];
    expect(plan.some((step) => step.detail.includes('idx_events_review_verdict'))).toBe(true);
    migrated.close();
    db.updateRun('old', { hostKind: 'detached', hostRef: '{"kind":"detached","pid":9}', logPath: '/l', exitPath: '/e', specPath: '/s', logOffset: 42, taskJson: '{"ticketId":"T-1"}' });
    const row = db.getRun('old')!;
    expect(row.hostKind).toBe('detached');
    expect(row.logOffset).toBe(42);
    expect(db.reattachableRuns().map((r) => r.id)).toContain('old');
    db.close();
  });
});
