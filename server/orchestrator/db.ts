import Database from 'better-sqlite3';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface RunRow {
  id: string;
  ticketId: string;
  repo: string;
  adapter: string;
  status: RunStatus;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  worktreePath: string | null;
  hostKind?: string | null;
  hostRef?: string | null;
  logPath?: string | null;
  exitPath?: string | null;
  specPath?: string | null;
  logOffset?: number | null;
  taskJson?: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  ts: string;
  kind: string;
  text: string;
}

export interface Db {
  insertRun(r: RunRow): void;
  updateRun(id: string, patch: Partial<RunRow>): void;
  getRun(id: string): RunRow | null;
  listRuns(limit: number): RunRow[];
  activeRuns(): RunRow[];
  reattachableRuns(): RunRow[];
  appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow;
  listEvents(runId: string): RunEventRow[];
  getConfigOverrides(): Record<string, string>;
  setConfigOverride(key: string, value: string, ts: string): void;
  close(): void;
}

const COLS: string[] = ['id', 'ticketId', 'repo', 'adapter', 'status', 'attempt', 'prNumber', 'startedAt', 'endedAt', 'costUsd', 'worktreePath', 'hostKind', 'hostRef', 'logPath', 'exitPath', 'specPath', 'logOffset', 'taskJson'];

export function openDb(path: string): Db {
  const sql: Database.Database = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT,
      attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, ts TEXT, kind TEXT, text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(runId, id);
    CREATE TABLE IF NOT EXISTS config_overrides (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);
  `);

  const existing = new Set((sql.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name));
  const addCols: [string, string][] = [
    ['hostKind', 'TEXT'], ['hostRef', 'TEXT'], ['logPath', 'TEXT'], ['exitPath', 'TEXT'],
    ['specPath', 'TEXT'], ['logOffset', 'INTEGER'], ['taskJson', 'TEXT'],
  ];
  for (const [name, type] of addCols) {
    if (!existing.has(name)) sql.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }

  return {
    insertRun(r: RunRow): void {
      const full = { hostKind: null, hostRef: null, logPath: null, exitPath: null, specPath: null, logOffset: null, taskJson: null, ...r };
      sql.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`).run(full);
    },
    updateRun(id: string, patch: Partial<RunRow>): void {
      const keys: string[] = Object.keys(patch).filter((k) => COLS.includes(k));
      if (keys.length === 0) return;
      const set: string = keys.map((k) => `${k} = @${k}`).join(', ');
      sql.prepare(`UPDATE runs SET ${set} WHERE id = @id`).run({ ...patch, id });
    },
    getRun(id: string): RunRow | null {
      return (sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
    },
    listRuns(limit: number): RunRow[] {
      return sql.prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT ?').all(limit) as RunRow[];
    },
    activeRuns(): RunRow[] {
      return sql.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC`).all() as RunRow[];
    },
    reattachableRuns(): RunRow[] {
      return sql.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC`).all() as RunRow[];
    },
    appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow {
      const info: Database.RunResult = sql.prepare('INSERT INTO run_events (runId, ts, kind, text) VALUES (?, ?, ?, ?)').run(runId, ts, kind, text);
      return { id: Number(info.lastInsertRowid), runId, ts, kind, text };
    },
    listEvents(runId: string): RunEventRow[] {
      return sql.prepare('SELECT * FROM run_events WHERE runId = ? ORDER BY id ASC').all(runId) as RunEventRow[];
    },
    getConfigOverrides(): Record<string, string> {
      const rows: { key: string; value: string }[] = sql.prepare('SELECT key, value FROM config_overrides').all() as { key: string; value: string }[];
      return rows.reduce((acc: Record<string, string>, row: { key: string; value: string }) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
    },
    setConfigOverride(key: string, value: string, ts: string): void {
      sql
        .prepare(
          'INSERT INTO config_overrides (key, value, updatedAt) VALUES (@key,@value,@ts) ON CONFLICT(key) DO UPDATE SET value=@value, updatedAt=@ts',
        )
        .run({ key, value, ts });
    },
    close(): void {
      sql.close();
    },
  };
}
