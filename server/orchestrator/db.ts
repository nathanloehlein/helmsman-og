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
  appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow;
  listEvents(runId: string): RunEventRow[];
  close(): void;
}

const COLS: string[] = ['id', 'ticketId', 'repo', 'adapter', 'status', 'attempt', 'prNumber', 'startedAt', 'endedAt', 'costUsd', 'worktreePath'];

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
  `);

  return {
    insertRun(r: RunRow): void {
      sql.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`).run(r);
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
    appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow {
      const info: Database.RunResult = sql.prepare('INSERT INTO run_events (runId, ts, kind, text) VALUES (?, ?, ?, ?)').run(runId, ts, kind, text);
      return { id: Number(info.lastInsertRowid), runId, ts, kind, text };
    },
    listEvents(runId: string): RunEventRow[] {
      return sql.prepare('SELECT * FROM run_events WHERE runId = ? ORDER BY id ASC').all(runId) as RunEventRow[];
    },
    close(): void {
      sql.close();
    },
  };
}
