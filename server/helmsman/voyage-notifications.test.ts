// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { openVoyageNotifications } from './voyage-notifications';

const fixtures: { root: string; db: Db; stores: ReturnType<typeof openVoyageNotifications>[] }[] = [];
afterEach(() => { for (const { root, db, stores } of fixtures.splice(0)) { for (const store of stores) store.close(); db.close(); rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'voyage-notifications-'));
  const path = join(root, 'runs.sqlite');
  const db = openDb(path);
  const store = openVoyageNotifications(path);
  const entry = { root, db, stores: [store] };
  fixtures.push(entry);
  return { db, store, path, reopen() { entry.stores.pop()?.close(); const next = openVoyageNotifications(path); entry.stores.push(next); return next; } };
}

const run = (id: string, extra: Partial<RunRow> = {}): RunRow => ({
  id, ticketId: 'TASK-1', repo: 'org/repo', adapter: 'pre-pr:codex', status: 'succeeded', attempt: 1,
  prNumber: null, startedAt: '2026-09-18T00:00:00Z', endedAt: '2026-09-18T01:00:00Z', costUsd: 0, worktreePath: null,
  taskJson: JSON.stringify({ title: ' Finished task ', model: 'gpt-5.6-sol', effort: 'high' }), ...extra,
});

describe('completed voyage notifications', () => {
  it('includes every terminal outcome without needing a PR or Slack setup, and excludes active runs', () => {
    const { db, store } = fixture();
    for (const status of ['succeeded', 'failed', 'stopped', 'running'] as const) db.insertRun(run(status, { status }));
    db.insertRun(run('no-ended-at', { endedAt: null }));
    const items = store.listNotifications();
    expect(items.map(item => item.status).sort()).toEqual(['failed', 'stopped', 'succeeded']);
    expect(items[0]).toMatchObject({ kind: 'voyage-completed', repo: 'org/repo', title: 'Finished task', prNumber: null, prUrl: '',
      author: 'Helmsman', channelName: 'Helmsman voyages', createdAt: '2026-09-18T01:00:00Z', updatedAt: '2026-09-18T01:00:00Z', readAt: null, error: null,
      model: 'gpt-5.6-sol', effort: 'high' });
    for (const item of items) {
      expect(item.id).toMatch(/^voyage-[a-f\d]{64}$/);
      expect(item.sourceUrl).toBe(`/runs?run=${item.runId}`);
    }
  });

  it('orders by completion time rather than start time and limits valid notifications to 100', () => {
    const { db, store } = fixture();
    for (let i = 0; i < 120; i++) db.insertRun(run(`ordinary-${i}`, { endedAt: new Date(Date.UTC(2026, 8, 18, 0, i)).toISOString() }));
    db.insertRun(run('long-running', { startedAt: '2020-01-01T00:00:00Z', endedAt: '2026-09-18T05:00:00Z' }));
    expect(store.listNotifications()).toHaveLength(100);
    expect(store.listNotifications(500)).toHaveLength(100);
    expect(store.listNotifications(2).map(item => item.runId)).toEqual(['long-running', 'ordinary-119']);
    expect(store.listNotifications(NaN)).toHaveLength(100);
  });

  it('sorts valid timestamps chronologically even when offsets differ', () => {
    const { db, store } = fixture();
    db.insertRun(run('earlier', { endedAt: '2026-09-18T03:00:00+05:00' }));
    db.insertRun(run('later', { endedAt: '2026-09-18T00:00:00Z' }));
    expect(store.listNotifications().map(item => item.runId)).toEqual(['later', 'earlier']);
  });

  it('uses the original title or ticket fallback and validates optional model/effort', () => {
    const { db, store } = fixture();
    db.insertRun(run('with-pr', { prNumber: 42, taskJson: JSON.stringify({ title: 'Review <PR> wording', model: 'arbitrary model<script>', effort: 'invented' }) }));
    db.insertRun(run('malformed-task', { taskJson: '{' }));
    db.insertRun(run('missing-title', { taskJson: JSON.stringify({ title: '  ' }) }));
    const items = store.listNotifications();
    const withPr = items.find(item => item.runId === 'with-pr');
    expect(withPr).toMatchObject({ title: 'Review <PR> wording', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' });
    expect(withPr).not.toHaveProperty('model'); expect(withPr).not.toHaveProperty('effort');
    expect(items.filter(item => item.runId !== 'with-pr').map(item => item.title)).toEqual(['TASK-1', 'TASK-1']);
  });

  it('keeps polling stable and preserves read state across restarts without changing runs', () => {
    const fixtureState = fixture();
    const { db, store } = fixtureState;
    db.insertRun(run('finished'));
    const before = db.getRun('finished');
    const item = store.listNotifications()[0]!;
    expect(store.listNotifications()).toEqual([item]);
    expect(store.markRead(item.id, '2026-09-18T02:00:00Z')).toBe(true);
    expect(store.markRead(item.id, '2026-09-18T03:00:00Z')).toBe(true);
    expect(fixtureState.reopen().listNotifications()).toEqual([{ ...item, readAt: '2026-09-18T02:00:00Z' }]);
    expect(db.getRun('finished')).toEqual(before);
  });

  it('removes resumed active runs and creates a fresh unread notification for the next completed attempt', () => {
    const { db, store } = fixture();
    db.insertRun(run('resumed', { status: 'failed' }));
    const old = store.listNotifications()[0]!;
    store.markRead(old.id, '2026-09-18T02:00:00Z');
    db.updateRun('resumed', { status: 'running', attempt: 2, endedAt: null });
    expect(store.listNotifications()).toEqual([]);
    expect(store.markRead(old.id, '2026-09-18T03:00:00Z')).toBe(false);
    db.updateRun('resumed', { status: 'succeeded', endedAt: '2026-09-18T04:00:00Z', prNumber: 3 });
    const next = store.listNotifications()[0]!;
    expect(next.id).not.toBe(old.id);
    expect(next.readAt).toBeNull();
    expect(store.markRead(old.id, '2026-09-18T05:00:00Z')).toBe(false);
  });

  it('refuses unknown/read IDs and invalid read timestamps, including notifications outside the current terminal revision', () => {
    const { db, store } = fixture();
    db.insertRun(run('finished'));
    const item = store.listNotifications()[0]!;
    expect(store.markRead(`voyage-${'0'.repeat(64)}`, '2026-09-18T03:00:00Z')).toBe(false);
    expect(store.markRead('slack-notification', '2026-09-18T03:00:00Z')).toBe(false);
    expect(store.markRead(item.id, 'invalid')).toBe(false);
    expect(store.listNotifications()[0]?.readAt).toBeNull();
  });

  it('skips malformed persisted runs and does not alter Slack notification data', () => {
    const { db, store, path } = fixture();
    const malformed = [run('bad-id/'), run('bad-repo', { repo: '../invalid' }), run('bad-date', { endedAt: 'not-date' }),
      run('bad-attempt', { attempt: 0 }), run('bad-pr', { prNumber: -1 }), run('bad-title', { taskJson: '{}', ticketId: '' })];
    for (const row of malformed) db.insertRun(row);
    db.insertRun(run('valid'));
    const sql = new Database(path);
    try {
      sql.exec("CREATE TABLE slack_notifications (id TEXT PRIMARY KEY, readAt TEXT); INSERT INTO slack_notifications VALUES ('slack-existing', NULL)");
      const items = store.listNotifications();
      expect(items.map(item => item.runId)).toEqual(['valid']);
      expect(store.markRead(items[0]!.id, '2026-09-18T03:00:00Z')).toBe(true);
      expect(sql.prepare('SELECT * FROM slack_notifications').all()).toEqual([{ id: 'slack-existing', readAt: null }]);
      expect(sql.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: malformed.length + 1 });
    } finally { sql.close(); }
  });
});
