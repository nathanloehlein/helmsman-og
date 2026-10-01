import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { isGithubRepo } from '../pr-lists';

export interface NotificationIdentity { kind: 'review' | 'voyage'; id: string; repo: string; }
export interface ClearNotificationsInput { repo: string | null; clearToken: string; }
export class NotificationHistoryError extends Error {}

export function initializeNotificationHistory(sql: Database.Database): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS notification_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
    repo TEXT NOT NULL COLLATE NOCASE, dismissed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(kind,id)
  );
  CREATE TABLE IF NOT EXISTS notification_history_key (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);`);
}

export function openNotificationHistory(database: string | Database.Database, identities: () => Iterable<NotificationIdentity>) {
  const ownsConnection = typeof database === 'string';
  const sql = ownsConnection ? new Database(database) : database;
  sql.pragma('journal_mode = WAL');
  initializeNotificationHistory(sql);
  sql.prepare('INSERT OR IGNORE INTO notification_history_key VALUES (1,?)').run(randomBytes(32).toString('hex'));
  const secret = (sql.prepare('SELECT secret FROM notification_history_key WHERE id=1').get() as { secret: string } | undefined)?.secret;
  if (!secret || !/^[a-f\d]{64}$/.test(secret)) throw new NotificationHistoryError('Notification history is unavailable');
  const signature = (sequence: string) => createHmac('sha256', secret).update(`notifications:${sequence}`).digest('hex');
  function cutoff(token: unknown): number {
    const match = typeof token === 'string' && /^(0|[1-9]\d{0,15}):([a-f\d]{64})$/.exec(token);
    if (!match || !Number.isSafeInteger(Number(match[1])) || !timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(signature(match[1]!), 'hex')))
      throw new NotificationHistoryError('Refresh notifications before clearing them');
    return Number(match[1]);
  }
  const insert = sql.prepare('INSERT OR IGNORE INTO notification_history(kind,id,repo) VALUES (?,?,?)');
  const existing = sql.prepare('SELECT repo FROM notification_history WHERE kind=? AND id=?');
  return {
    capture<T>(read: () => T): { value: T; clearToken: string } {
      return sql.transaction(() => {
        for (const item of Array.from(identities())) {
          if (!item || !['review', 'voyage'].includes(item.kind) || typeof item.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(item.id)
            || typeof item.repo !== 'string' || !isGithubRepo(item.repo)) throw new NotificationHistoryError('Invalid notification identity');
          const repo = item.repo.toLowerCase();
          const prior = existing.get(item.kind, item.id) as { repo: string } | undefined;
          if (prior && prior.repo !== repo) throw new NotificationHistoryError('Notification repository changed');
          if (!prior) insert.run(item.kind, item.id, repo);
        }
        const sequence = String((sql.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM notification_history').get() as { sequence: number }).sequence);
        const value = read();
        if (value && typeof value === 'object' && 'then' in value) throw new NotificationHistoryError('Notification snapshots must be synchronous');
        return { value, clearToken: `${sequence}:${signature(sequence)}` };
      }).immediate();
    },
    clear(input: ClearNotificationsInput): ClearNotificationsInput & { cleared: number } {
      if (!input || Object.keys(input).some(key => !['repo', 'clearToken'].includes(key))
        || input.repo !== null && (typeof input.repo !== 'string' || !isGithubRepo(input.repo))) throw new NotificationHistoryError('Invalid notification scope');
      const sequence = cutoff(input.clearToken);
      return sql.transaction(() => {
        const cleared = input.repo === null
          ? sql.prepare('UPDATE notification_history SET dismissed=1 WHERE dismissed=0 AND sequence<=?').run(sequence).changes
          : sql.prepare('UPDATE notification_history SET dismissed=1 WHERE dismissed=0 AND sequence<=? AND repo=? COLLATE NOCASE').run(sequence, input.repo).changes;
        return { repo: input.repo, clearToken: input.clearToken, cleared };
      }).immediate();
    },
    close() { if (ownsConnection) sql.close(); },
  };
}
