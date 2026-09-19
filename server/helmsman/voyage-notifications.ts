import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { VoyageNotification } from '../../src/data/slack';
import { validEffort, validModel } from '../../src/logic/agentOptions';
import { isGithubRepo } from '../pr-lists';

const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;

function notificationId(runId: unknown, attempt: unknown, endedAt: unknown): string | null {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)
    || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || !timestamp(endedAt)) return null;
  return `voyage-${createHash('sha256').update(JSON.stringify([runId, attempt, endedAt])).digest('hex')}`;
}

function taskData(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const task: unknown = JSON.parse(value);
    return task && typeof task === 'object' && !Array.isArray(task) ? task as Record<string, unknown> : null;
  } catch { return null; }
}

function notification(value: unknown): VoyageNotification | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = notificationId(row.id, row.attempt, row.endedAt);
  if (!id || typeof row.id !== 'string' || !timestamp(row.endedAt) || typeof row.repo !== 'string' || !isGithubRepo(row.repo)
    || (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'stopped')
    || !(row.prNumber === null || typeof row.prNumber === 'number' && Number.isSafeInteger(row.prNumber) && row.prNumber > 0)) return null;
  const task = taskData(row.taskJson);
  const title = text(task?.title) ?? text(row.ticketId);
  if (!title) return null;
  const model = typeof task?.model === 'string' && task.model.length <= 128 ? validModel(task.model) : null;
  const effort = typeof task?.effort === 'string' ? validEffort(task.effort) : null;
  return {
    kind: 'voyage-completed', id, repo: row.repo, runId: row.id, title, status: row.status,
    prNumber: row.prNumber, prUrl: row.prNumber === null ? '' : `https://github.com/${row.repo}/pull/${row.prNumber}`,
    sourceUrl: `/runs?run=${encodeURIComponent(row.id)}`, author: 'Helmsman', channelName: 'Helmsman voyages',
    createdAt: row.endedAt, updatedAt: row.endedAt, readAt: timestamp(row.readAt) ? row.readAt : null, error: null,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}),
  };
}

export function openVoyageNotifications(path: string): {
  listNotifications(limit?: number): VoyageNotification[];
  markRead(id: string, now: string): boolean;
  close(): void;
} {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec('CREATE TABLE IF NOT EXISTS voyage_notification_reads (id TEXT PRIMARY KEY, readAt TEXT NOT NULL)');
  sql.function('voyage_notification_id', { deterministic: true }, notificationId);
  const select = `SELECT runs.*, reads.readAt FROM runs
    LEFT JOIN voyage_notification_reads AS reads ON reads.id = voyage_notification_id(runs.id, runs.attempt, runs.endedAt)
    WHERE runs.status IN ('succeeded', 'failed', 'stopped') AND runs.endedAt IS NOT NULL`;
  const list = sql.prepare(`${select} ORDER BY julianday(runs.endedAt) DESC, runs.endedAt DESC, runs.id DESC`);
  const find = sql.prepare(`${select} AND voyage_notification_id(runs.id, runs.attempt, runs.endedAt) = ? LIMIT 1`);
  const insertRead = sql.prepare('INSERT OR IGNORE INTO voyage_notification_reads (id, readAt) VALUES (?, ?)');
  const markRead = sql.transaction((id: string, now: string): boolean => {
    if (!/^voyage-[a-f\d]{64}$/.test(id) || !timestamp(now) || !notification(find.get(id))) return false;
    insertRead.run(id, now);
    return true;
  });
  return {
    listNotifications(limit = 100) {
      const count = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 100;
      const notifications: VoyageNotification[] = [];
      for (const row of list.iterate()) {
        const item = notification(row);
        if (item) notifications.push(item);
        if (notifications.length >= count) break;
      }
      return notifications;
    },
    markRead: (id, now) => markRead.immediate(id, now),
    close: () => sql.close(),
  };
}
