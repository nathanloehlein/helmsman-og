// @vitest-environment node
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type RunRow } from './db';
import { openSlackStore, type SlackNotification } from './slack/store';
import { openVoyageNotifications } from './voyage-notifications';
import { openNotificationHistory } from './notification-history';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const date = '2026-10-01T12:00:00Z';
const notification = (id: string, repo = 'org/repo'): SlackNotification => ({ id, repo, prNumber: 42, prUrl: `https://github.com/${repo}/pull/42`,
  sourceUrl: '', author: 'Alex', channelName: 'GitHub requested reviews', status: 'queued', runId: null, createdAt: date, updatedAt: date, readAt: null, error: null });
const run = (id: string, repo = 'org/repo'): RunRow => ({ id, repo, ticketId: 'TASK-1', adapter: 'codex', attempt: 1, status: 'succeeded',
  prNumber: null, startedAt: date, endedAt: date, costUsd: 0, worktreePath: null, taskJson: JSON.stringify({ title: 'Completed task' }) });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notification-history-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const db = openDb(path); cleanup.push(() => db.close());
  const reviews = openSlackStore(path); cleanup.push(() => reviews.close());
  const voyages = openVoyageNotifications(path); cleanup.push(() => voyages.close());
  const identities = function* () { yield* reviews.notificationIdentities(); yield* voyages.notificationIdentities(); };
  let history = openNotificationHistory(path, identities); cleanup.push(() => history.close());
  const snapshot = () => history.capture(() => [...reviews.listNotifications(), ...voyages.listNotifications()]);
  return { db, reviews, voyages, path, snapshot, get history() { return history; }, reopen() { history.close(); history = openNotificationHistory(path, identities); } };
}

describe('persistent notification dismissal', () => {
  it('clears all captured history beyond display caps without changing jobs, deduplication or voyages', () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) { f.reviews.insertNotification('source', notification(`review-${i}`)); f.db.insertRun(run(`voyage-${i}`)); }
    f.reviews.claimDispatch('review-0', 'claim', date);
    const review = f.reviews.getNotification('review-0'); const voyage = f.db.getRun('voyage-0');
    const snapshot = f.snapshot(); expect(snapshot.value).toHaveLength(200);
    expect(f.history.clear({ repo: null, clearToken: snapshot.clearToken }).cleared).toBe(240);
    expect(f.snapshot().value).toEqual([]);
    expect(f.reviews.queuedNotifications('source')).toHaveLength(120);
    expect(f.reviews.getNotification('review-0')).toEqual(review);
    expect(f.reviews.ownsDispatch('review-0', 'claim')).toBe(true);
    expect(f.reviews.insertNotification('source', notification('review-0'))).toBe(false);
    expect(f.db.getRun('voyage-0')).toEqual(voyage);
    f.reopen(); expect(f.snapshot().value).toEqual([]);
    expect(f.history.clear({ repo: null, clearToken: snapshot.clearToken }).cleared).toBe(0);
  });
  it('honors galleon scope case-insensitively and clears both read and unread notifications', () => {
    const f = fixture();
    f.reviews.insertNotification('source', notification('selected')); f.reviews.markRead('selected', date);
    f.reviews.insertNotification('source', notification('other', 'org/other'));
    f.db.insertRun(run('selected')); f.db.insertRun(run('other', 'org/other'));
    const snapshot = f.snapshot();
    expect(f.history.clear({ repo: 'ORG/REPO', clearToken: snapshot.clearToken }).cleared).toBe(2);
    expect(f.snapshot().value.map(item => item.repo)).toEqual(['org/other', 'org/other']);
  });
  it('preserves arrivals after capture even when backdated or observed before a retried clear', () => {
    const f = fixture(); f.reviews.insertNotification('source', notification('old')); f.db.insertRun(run('old'));
    const first = f.snapshot();
    f.reviews.insertNotification('source', { ...notification('new'), createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
    f.db.insertRun({ ...run('new'), endedAt: '2020-01-01T00:00:00Z' });
    f.snapshot();
    f.history.clear({ repo: null, clearToken: first.clearToken });
    expect(f.snapshot().value.map(item => 'kind' in item && item.kind === 'voyage-completed' ? item.runId : item.id)).toEqual(['new', 'new']);
    f.reopen(); expect(f.history.clear({ repo: null, clearToken: first.clearToken }).cleared).toBe(0);
    expect(f.snapshot().value).toHaveLength(2);
  });
  it('keeps an updated dismissed review hidden and a new voyage attempt visible', () => {
    const f = fixture(); f.reviews.insertNotification('source', notification('review')); f.db.insertRun(run('voyage'));
    f.history.clear({ repo: null, clearToken: f.snapshot().clearToken });
    f.reviews.updateNotification('review', 'launched', date); f.reviews.setNotificationRunId('review', 'voyage');
    f.db.updateRun('voyage', { attempt: 2 });
    expect(f.snapshot().value).toMatchObject([{ kind: 'voyage-completed', runId: 'voyage' }]);
    expect(f.reviews.launchedNotifications('source')).toHaveLength(1);
  });
  it('does not grow the sequence on unchanged polling and rejects forged cutoff tokens', () => {
    const f = fixture(); f.reviews.insertNotification('source', notification('old'));
    const first = f.snapshot(); expect(f.snapshot().clearToken).toBe(first.clearToken);
    const sql = new Database(f.path); cleanup.push(() => sql.close());
    expect(sql.prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_history'").get()).toEqual({ seq: 1 });
    expect(() => f.history.clear({ repo: null, clearToken: `999:${first.clearToken.split(':')[1]}` })).toThrow('Refresh');
    expect(() => f.history.clear({ repo: '../escape', clearToken: first.clearToken })).toThrow('scope');
    expect(f.snapshot().value).toHaveLength(1);
  });
  it('rolls back cutoff capture if reading the snapshot fails', () => {
    const f = fixture(); f.reviews.insertNotification('source', notification('old'));
    expect(() => f.history.capture(() => { throw new Error('failed snapshot'); })).toThrow('failed snapshot');
    const sql = new Database(f.path); cleanup.push(() => sql.close());
    expect(sql.prepare('SELECT COUNT(*) AS count FROM notification_history').get()).toEqual({ count: 0 });
  });
});

it('lists a quiet galleon before caps and clears it without dismissing a busy galleon', () => {
  const f = fixture(); f.reviews.insertNotification('source', notification('quiet')); f.db.insertRun(run('quiet'));
  for (let i = 0; i < 120; i++) {
    f.reviews.insertNotification('source', { ...notification(`busy-${i}`, 'org/other'), updatedAt: '2026-10-02T00:00:00Z' });
    f.db.insertRun({ ...run(`busy-${i}`, 'org/other'), endedAt: '2026-10-02T00:00:00Z' });
  }
  expect(f.snapshot().value.every(item => item.repo === 'org/other')).toBe(true);
  const selected = f.history.capture(() => [...f.reviews.listNotifications(100, 'ORG/REPO'), ...f.voyages.listNotifications(100, 'ORG/REPO')]);
  expect(selected.value).toHaveLength(2); expect(selected.value.every(item => item.repo === 'org/repo')).toBe(true);
  expect(f.history.clear({ repo: 'org/repo', clearToken: selected.clearToken }).cleared).toBe(2);
  expect(f.reviews.listNotifications(100, 'org/repo')).toEqual([]); expect(f.voyages.listNotifications(100, 'org/repo')).toEqual([]);
  expect(f.snapshot().value).toHaveLength(200); expect(f.reviews.queuedNotifications('source')).toHaveLength(121);
});
