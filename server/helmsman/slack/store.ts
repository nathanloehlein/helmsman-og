import Database from 'better-sqlite3';

export interface SlackNotification {
  id: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  sourceUrl: string;
  author: string;
  channelName: string;
  status: 'queued' | 'launched' | 'failed' | 'blocked';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  error: string | null;
}

export interface SlackHealth {
  enabled: boolean;
  status: 'disabled' | 'healthy' | 'scanning' | 'partial' | 'unavailable';
  channelName: string;
  intervalMs: number;
  lastSuccessAt: string | null;
  error: string | null;
}

export interface SlackSourceState {
  key: string;
  activatedAt: string;
  cursor: string | null;
  health: SlackHealth;
}

export interface SlackStore {
  ensureSource(key: string, activatedAt: string, health: SlackHealth): SlackSourceState;
  saveSource(state: SlackSourceState): void;
  insertNotification(sourceKey: string, notification: SlackNotification): boolean;
  queuedNotifications(sourceKey: string): SlackNotification[];
  launchedNotifications(sourceKey: string): SlackNotification[];
  updateNotification(id: string, status: SlackNotification['status'], now: string, error?: string | null): void;
  setNotificationRunId(id: string, runId: string): void;
  getNotification(id: string): SlackNotification | null;
  listNotifications(limit?: number): SlackNotification[];
  markRead(id: string, now: string): boolean;
  claimDispatch(id: string, token: string, now: string): boolean;
  dispatchClaims(sourceKey: string): Array<{ notificationId: string; token: string; claimedAt: string }>;
  ownsDispatch(id: string, token: string): boolean;
  releaseDispatch(id: string, token: string): boolean;
  close(): void;
}

const NOTIFICATION_COLUMNS = 'id, repo, prNumber, prUrl, sourceUrl, author, channelName, status, runId, createdAt, updatedAt, readAt, error';

export function openSlackStore(path: string): SlackStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slack_sources (
      key TEXT PRIMARY KEY, activatedAt TEXT NOT NULL, cursor TEXT, health TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_notifications (
      id TEXT PRIMARY KEY, sourceKey TEXT NOT NULL, repo TEXT NOT NULL,
      prNumber INTEGER NOT NULL, prUrl TEXT NOT NULL, sourceUrl TEXT NOT NULL,
      author TEXT NOT NULL, channelName TEXT NOT NULL, status TEXT NOT NULL,
      runId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, readAt TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS slack_notifications_queue ON slack_notifications(sourceKey, status, createdAt);
    CREATE TABLE IF NOT EXISTS slack_dispatch_claims (
      notificationId TEXT PRIMARY KEY, token TEXT NOT NULL, claimedAt TEXT NOT NULL
    );
  `);
  return {
    ensureSource(key, activatedAt, health) {
      sql.prepare('INSERT OR IGNORE INTO slack_sources (key, activatedAt, cursor, health) VALUES (?, ?, NULL, ?)')
        .run(key, activatedAt, JSON.stringify(health));
      const row = sql.prepare('SELECT * FROM slack_sources WHERE key = ?').get(key) as Omit<SlackSourceState, 'health'> & { health: string };
      return { ...row, health: JSON.parse(row.health) as SlackHealth };
    },
    saveSource(state) {
      sql.prepare('UPDATE slack_sources SET cursor = ?, health = ? WHERE key = ?')
        .run(state.cursor, JSON.stringify(state.health), state.key);
    },
    insertNotification(sourceKey, notification) {
      return sql.prepare(`INSERT OR IGNORE INTO slack_notifications (sourceKey, ${NOTIFICATION_COLUMNS})
        VALUES (@sourceKey, @id, @repo, @prNumber, @prUrl, @sourceUrl, @author, @channelName, @status, @runId, @createdAt, @updatedAt, @readAt, @error)`)
        .run({ sourceKey, ...notification }).changes > 0;
    },
    queuedNotifications(sourceKey) {
      return sql.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM slack_notifications WHERE sourceKey = ? AND status = 'queued' ORDER BY createdAt, id`)
        .all(sourceKey) as SlackNotification[];
    },
    launchedNotifications(sourceKey) {
      return sql.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM slack_notifications WHERE sourceKey = ? AND status = 'launched'`)
        .all(sourceKey) as SlackNotification[];
    },
    updateNotification(id, status, now, error = null) {
      sql.prepare('UPDATE slack_notifications SET status = ?, updatedAt = ?, readAt = NULL, error = ? WHERE id = ?')
        .run(status, now, error, id);
    },
    setNotificationRunId(id, runId) {
      sql.prepare('UPDATE slack_notifications SET runId = ? WHERE id = ?').run(runId, id);
    },
    getNotification(id) {
      return (sql.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM slack_notifications WHERE id = ?`).get(id) as SlackNotification | undefined) ?? null;
    },
    listNotifications(limit = 100) {
      const count = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100;
      return sql.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM slack_notifications ORDER BY updatedAt DESC, id DESC LIMIT ?`)
        .all(count) as SlackNotification[];
    },
    markRead(id, now) {
      return sql.prepare('UPDATE slack_notifications SET readAt = COALESCE(readAt, ?) WHERE id = ?').run(now, id).changes > 0;
    },
    claimDispatch(id, token, now) {
      if (!id || !token || !Number.isFinite(Date.parse(now))) throw new Error('Invalid dispatch claim');
      return sql.prepare(`INSERT OR IGNORE INTO slack_dispatch_claims (notificationId, token, claimedAt)
        SELECT id, ?, ? FROM slack_notifications WHERE id = ? AND status = 'queued'`).run(token, now, id).changes > 0;
    },
    dispatchClaims(sourceKey) {
      return sql.prepare(`SELECT claim.notificationId, claim.token, claim.claimedAt FROM slack_dispatch_claims claim
        JOIN slack_notifications notification ON notification.id = claim.notificationId WHERE notification.sourceKey = ?`)
        .all(sourceKey) as Array<{ notificationId: string; token: string; claimedAt: string }>;
    },
    ownsDispatch(id, token) {
      return !!sql.prepare('SELECT 1 FROM slack_dispatch_claims WHERE notificationId = ? AND token = ?').get(id, token);
    },
    releaseDispatch(id, token) {
      return sql.prepare('DELETE FROM slack_dispatch_claims WHERE notificationId = ? AND token = ?').run(id, token).changes > 0;
    },
    close() { sql.close(); },
  };
}
