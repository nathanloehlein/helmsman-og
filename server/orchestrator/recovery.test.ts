import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { recoverOrphanedRuns } from './recovery';

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

describe('recoverOrphanedRuns', () => {
  it('marks orphaned running runs as failed and leaves others untouched', () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a', status: 'running' }));
    db.insertRun(run({ id: 'b', status: 'running' }));
    db.insertRun(run({ id: 'c', status: 'succeeded', endedAt: '2026-08-17T00:00:00.000Z' }));

    const recovered: string[] = recoverOrphanedRuns(db, () => '2026-08-18T00:00:00.000Z');

    expect(new Set(recovered)).toEqual(new Set(['a', 'b']));

    const a: RunRow | null = db.getRun('a');
    const b: RunRow | null = db.getRun('b');
    expect(a?.status).toBe('failed');
    expect(a?.endedAt).toBe('2026-08-18T00:00:00.000Z');
    expect(b?.status).toBe('failed');
    expect(b?.endedAt).toBe('2026-08-18T00:00:00.000Z');

    const c: RunRow | null = db.getRun('c');
    expect(c?.status).toBe('succeeded');
    expect(c?.endedAt).toBe('2026-08-17T00:00:00.000Z');

    expect(db.listEvents('a').some((e) => e.text.includes('interrupted'))).toBe(true);
    expect(db.listEvents('b').some((e) => e.text.includes('interrupted'))).toBe(true);
  });
});
