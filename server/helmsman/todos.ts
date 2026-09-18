import Database from 'better-sqlite3';
import { TODO_PRIORITIES, TODO_STATES, type Todo, type TodoInput } from '../../src/data/todos';

export class TodoValidationError extends Error {}
export class TodoConflictError extends Error {}

export interface TodoStore {
  list(): Todo[];
  get(id: string): Todo | null;
  create(input: unknown): Todo;
  update(id: string, patch: unknown): Todo | null;
  remove(id: string): boolean;
  claim(id: string, runId: string, retryRunId?: string): Todo | null;
  release(id: string, runId: string): boolean;
  finishRun(runId: string, status: 'succeeded' | 'failed' | 'stopped'): boolean;
  close(): void;
}

const FIELDS = ['title', 'repo', 'description', 'acceptanceCriteria', 'priority', 'state'] as const;
const COLUMNS = "'TODO-' || sequence AS id, title, repo, description, acceptanceCriteria, priority, state, createdAt, updatedAt, completedAt, runId";

function validateInput(input: unknown, partial: boolean): Partial<TodoInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TodoValidationError('Todo must be an object');
  }
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !FIELDS.some((field) => field === key))) {
    throw new TodoValidationError('Unknown todo field');
  }
  const result: Record<string, string> = {};
  for (const field of FIELDS) {
    if (!(field in values)) continue;
    if (typeof values[field] !== 'string') throw new TodoValidationError(`${field} must be a string`);
    result[field] = values[field].trim();
  }
  for (const field of ['title', 'repo'] as const) {
    if ((!partial || field in result) && !result[field]) throw new TodoValidationError(`${field} is required`);
  }
  if (result.title && result.title.length > 240) throw new TodoValidationError('Title must be 240 characters or fewer');
  if (result.repo && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(result.repo)) {
    throw new TodoValidationError('Repository must use owner/name format');
  }
  for (const field of ['description', 'acceptanceCriteria'] as const) {
    if ((result[field]?.length ?? 0) > 20000) throw new TodoValidationError(`${field} must be 20000 characters or fewer`);
  }
  if (result.priority !== undefined && !TODO_PRIORITIES.some((value) => value === result.priority)) {
    throw new TodoValidationError('Priority must be P0 through P4');
  }
  if (result.state !== undefined && !TODO_STATES.some((value) => value === result.state)) {
    throw new TodoValidationError('Invalid todo state');
  }
  if (result.state === 'in_progress') throw new TodoValidationError('Start a voyage to move a todo into progress');
  return result as Partial<TodoInput>;
}

function sequence(id: string): number | null {
  if (typeof id !== 'string' || !/^TODO-[1-9]\d*$/.test(id)) return null;
  const value = Number(id.slice(5));
  return Number.isSafeInteger(value) ? value : null;
}

export function openTodoStore(path: string, now: () => string = () => new Date().toISOString()): TodoStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, repo TEXT NOT NULL, description TEXT NOT NULL,
      acceptanceCriteria TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
      state TEXT NOT NULL CHECK(state IN ('todo', 'in_progress', 'in_review', 'done', 'blocked')),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT, runId TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS todos_queue ON todos(state, priority, sequence);
  `);
  sql.transaction(() => {
    const columns = sql.prepare('PRAGMA table_info(todos)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'completedAt')) {
      sql.exec('ALTER TABLE todos ADD COLUMN completedAt TEXT');
      sql.exec("UPDATE todos SET completedAt = updatedAt WHERE state = 'done'");
    }
  }).immediate();
  const read = sql.prepare(`SELECT ${COLUMNS} FROM todos WHERE sequence = ?`);
  const get = (id: string): Todo | null => (read.get(sequence(id)) as Todo | undefined) ?? null;
  const ensureMutable = (todo: Todo | null): void => {
    if (todo?.state === 'in_progress') throw new TodoConflictError('Stop the active voyage before changing this todo');
  };

  return {
    list: () => sql.prepare(`SELECT ${COLUMNS} FROM todos ORDER BY priority, sequence`).all() as Todo[],
    get,
    create(input) {
      const values = validateInput(input, false);
      const timestamp = now();
      const result = sql.prepare(`INSERT INTO todos (title, repo, description, acceptanceCriteria, priority, state, createdAt, updatedAt, completedAt)
        VALUES (@title, @repo, @description, @acceptanceCriteria, @priority, @state, @createdAt, @updatedAt, @completedAt)`)
        .run({ description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo', ...values, createdAt: timestamp, updatedAt: timestamp, completedAt: values.state === 'done' ? timestamp : null });
      return read.get(result.lastInsertRowid) as Todo;
    },
    update: sql.transaction((id: string, patch: unknown): Todo | null => {
      const values = validateInput(patch, true);
      const current = get(id);
      if (!current) return null;
      ensureMutable(current);
      const keys = Object.keys(values);
      if (keys.length === 0) return current;
      const timestamp = now();
      const completedAt = (values.state ?? current.state) === 'done' ? current.completedAt ?? timestamp : null;
      sql.prepare(`UPDATE todos SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, updatedAt = @updatedAt, completedAt = @completedAt WHERE sequence = @sequence`)
        .run({ ...values, updatedAt: timestamp, completedAt, sequence: sequence(id) });
      return get(id);
    }).immediate,
    remove: sql.transaction((id: string): boolean => {
      ensureMutable(get(id));
      return sql.prepare('DELETE FROM todos WHERE sequence = ?').run(sequence(id)).changes > 0;
    }).immediate,
    claim: sql.transaction((id: string, runId: string, retryRunId?: string): Todo | null => {
      if (typeof runId !== 'string' || !runId.trim()) throw new TodoValidationError('Run ID is required');
      const current = get(id);
      if (!current || (retryRunId ? current.runId !== retryRunId || !['todo', 'blocked'].includes(current.state) : current.state !== 'todo')) return null;
      if (!current.description.trim()) throw new TodoValidationError('Add a description before starting a voyage');
      if (sql.prepare('SELECT 1 FROM todos WHERE runId = ?').get(runId)) {
        throw new TodoConflictError('Run is already linked to a todo');
      }
      sql.prepare("UPDATE todos SET state = 'in_progress', runId = ?, updatedAt = ? WHERE sequence = ?")
        .run(runId, now(), sequence(id));
      return get(id);
    }).immediate,
    release(id, runId) {
      return sql.prepare("UPDATE todos SET state = 'todo', runId = NULL, updatedAt = ? WHERE sequence = ? AND state = 'in_progress' AND runId = ?")
        .run(now(), sequence(id), runId).changes > 0;
    },
    finishRun(runId, status) {
      if (!['succeeded', 'failed', 'stopped'].includes(status)) throw new TodoValidationError('Invalid run outcome');
      return sql.prepare("UPDATE todos SET state = ?, updatedAt = ? WHERE runId = ? AND state = 'in_progress'")
        .run(status === 'succeeded' ? 'in_review' : 'blocked', now(), runId).changes > 0;
    },
    close: () => sql.close(),
  };
}
