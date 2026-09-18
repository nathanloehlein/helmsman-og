import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openTodoStore, TodoConflictError, TodoValidationError, type TodoStore } from './todos';

const stores: TodoStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(path = ':memory:', now = () => '2026-09-18T12:00:00.000Z'): TodoStore {
  const result = openTodoStore(path, now);
  stores.push(result);
  return result;
}

const input = { title: 'Fix retry flow', repo: 'owner/repo', description: 'Retry the failed request without duplicating the save.' };

describe('local todos', () => {
  it('creates drafts with stable defaults and trims text', () => {
    const db = store();
    const todo = db.create({ title: '  Draft voyage  ', repo: ' owner/repo ' });
    expect(todo).toEqual({
      id: 'TODO-1', title: 'Draft voyage', repo: 'owner/repo', description: '', acceptanceCriteria: '',
      priority: 'P2', state: 'todo', runId: null, completedAt: null, createdAt: '2026-09-18T12:00:00.000Z', updatedAt: '2026-09-18T12:00:00.000Z',
    });
    expect(db.get(todo.id)).toEqual(todo);
    expect(db.get('TODO-01')).toBeNull();
    expect(db.get('missing')).toBeNull();
    expect(() => db.claim(todo.id, 'run-1')).toThrow('Add a description');
    expect(db.get(todo.id)?.state).toBe('todo');
  });

  it('keeps IDs unique after deletion and across separate connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-todos-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const first = store(path);
    const created = first.create(input);
    const second = store(path);
    expect(second.get(created.id)).toEqual(created);
    expect(second.remove(created.id)).toBe(true);
    expect(first.create(input).id).toBe('TODO-2');
  });

  it('orders by priority, then oldest first for a predictable queue', () => {
    const db = store();
    const medium = db.create(input);
    const urgent = db.create({ ...input, priority: 'P0' });
    const later = db.create(input);
    expect(db.list().map(({ id }) => id)).toEqual([urgent.id, medium.id, later.id]);
  });

  it.each([
    null, [], 'todo', {}, { ...input, title: ' ' }, { ...input, repo: '../local' },
    { ...input, repo: 'owner/repo/extra' }, { ...input, priority: 'P5' }, { ...input, priority: 2 },
    { ...input, state: 'running' }, { ...input, state: 'in_progress' }, { ...input, description: null },
    { ...input, runId: 'injected' }, { ...input, title: 'x'.repeat(241) }, { ...input, description: 'x'.repeat(20001) },
  ])('rejects malformed create input %#', (invalid) => {
    const db = store();
    expect(() => db.create(invalid)).toThrow(TodoValidationError);
    expect(db.list()).toEqual([]);
  });

  it('updates editable fields without losing other values or allowing internal field injection', () => {
    const db = store();
    const todo = db.create(input);
    expect(db.update(todo.id, { priority: 'P1', acceptanceCriteria: 'One saved record per retry.', state: 'blocked' }))
      .toMatchObject({ ...input, priority: 'P1', acceptanceCriteria: 'One saved record per retry.', state: 'blocked' });
    expect(() => db.update(todo.id, { id: 'TODO-99' })).toThrow(TodoValidationError);
    expect(() => db.update(todo.id, { title: null })).toThrow(TodoValidationError);
    expect(db.update('TODO-99', { title: 'Missing' })).toBeNull();
    expect(db.remove('TODO-99')).toBe(false);
  });

  it('atomically claims the todo and reserves its run across connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-todos-claim-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const first = store(path);
    const second = store(path);
    const todo = first.create(input);
    expect(first.claim(todo.id, 'run-1')).toMatchObject({ state: 'in_progress', runId: 'run-1' });
    expect(second.claim(todo.id, 'run-2')).toBeNull();
    expect(() => second.update(todo.id, { description: 'Changed work' })).toThrow(TodoConflictError);
    expect(() => second.remove(todo.id)).toThrow(TodoConflictError);
    expect(first.get(todo.id)?.runId).toBe('run-1');
    const other = first.create(input);
    expect(() => second.claim(other.id, 'run-1')).toThrow(TodoConflictError);
    expect(first.get(other.id)?.state).toBe('todo');
  });

  it('only releases the matching launch reservation', () => {
    const db = store();
    const todo = db.create(input);
    db.claim(todo.id, 'run-1');
    expect(db.release(todo.id, 'old-run')).toBe(false);
    expect(db.release(todo.id, 'run-1')).toBe(true);
    expect(db.get(todo.id)).toMatchObject({ state: 'todo', runId: null });
    expect(db.release(todo.id, 'run-1')).toBe(false);
  });

  it.each([
    ['succeeded', 'in_review'], ['failed', 'blocked'], ['stopped', 'blocked'],
  ] as const)('moves a %s voyage to %s and retains its run for inspection', (outcome, state) => {
    const db = store();
    const todo = db.create(input);
    db.claim(todo.id, 'run-1');
    expect(db.finishRun('run-1', outcome)).toBe(true);
    expect(db.get(todo.id)).toMatchObject({ state, runId: 'run-1' });
    expect(db.finishRun('run-1', outcome)).toBe(false);
    expect(db.claim(todo.id, 'run-2')).toBeNull();
  });

  it('ignores stale completion after a user explicitly queues a new attempt', () => {
    const db = store();
    const todo = db.create(input);
    db.claim(todo.id, 'run-1');
    db.finishRun('run-1', 'failed');
    db.update(todo.id, { state: 'todo' });
    db.claim(todo.id, 'run-2');
    expect(db.finishRun('run-1', 'succeeded')).toBe(false);
    expect(db.release(todo.id, 'run-1')).toBe(false);
    expect(db.get(todo.id)).toMatchObject({ state: 'in_progress', runId: 'run-2' });
  });

  it('preserves completion dates through edits and records a new date only after reopening', () => {
    let timestamp = '2026-09-16T12:00:00.000Z';
    const db = store(':memory:', () => timestamp);
    const todo = db.create({ ...input, state: 'done' });
    expect(todo.completedAt).toBe(timestamp);
    timestamp = '2026-09-17T12:00:00.000Z';
    expect(db.update(todo.id, { title: 'Updated wording', state: 'done' })).toMatchObject({
      completedAt: '2026-09-16T12:00:00.000Z', updatedAt: timestamp,
    });
    expect(db.update(todo.id, { state: 'todo' })?.completedAt).toBeNull();
    timestamp = '2026-09-18T12:00:00.000Z';
    expect(db.update(todo.id, { state: 'done' })?.completedAt).toBe(timestamp);
    expect(() => db.update(todo.id, { completedAt: '2020-01-01' })).toThrow(TodoValidationError);
  });

  it('migrates existing completed items once using their last known timestamp', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-todos-migration-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE todos (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, repo TEXT, description TEXT,
      acceptanceCriteria TEXT, priority TEXT, state TEXT, createdAt TEXT, updatedAt TEXT, runId TEXT
    );
    INSERT INTO todos (title, repo, description, acceptanceCriteria, priority, state, createdAt, updatedAt)
      VALUES ('Legacy', 'owner/repo', '', '', 'P2', 'done', '2026-09-10', '2026-09-11');`);
    legacy.close();
    const first = store(path);
    expect(first.get('TODO-1')?.completedAt).toBe('2026-09-11');
    first.update('TODO-1', { priority: 'P0' });
    const reopened = store(path);
    expect(reopened.get('TODO-1')).toMatchObject({ completedAt: '2026-09-11', updatedAt: '2026-09-18T12:00:00.000Z' });
  });
});
