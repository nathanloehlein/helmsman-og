import { afterEach, describe, expect, it } from 'vitest';
import { openTodoStore, type TodoStore } from './todos';
import { openDb, type Db, type RunRow } from './db';
import { reconcileTodoRuns, todoTask } from './todo-source';

let todos: TodoStore;
let db: Db;
afterEach(() => { todos?.close(); db?.close(); });

function setup() {
  todos = openTodoStore(':memory:');
  db = openDb(':memory:');
  return todos.create({ title: 'Fix pagination', repo: 'owner/repo', description: 'Preserve selected page.', acceptanceCriteria: 'Back restores page 2.', priority: 'P1' });
}

describe('local voyage source', () => {
  it('passes complete stored requirements into the normal agent task without Jira', () => {
    const todo = setup();
    const task = todoTask(todo);
    expect(task).toMatchObject({ todoId: todo.id, ticketId: todo.id, title: todo.title, repo: todo.repo, jiraBaseUrl: '' });
    expect(task.task).toContain(todo.description);
    expect(task.task).toContain(todo.acceptanceCriteria);
    expect(task.task).toContain('Priority: P1');
    expect(task.task).toContain('do not read or update Jira');
  });

  it.each(['succeeded', 'failed', 'stopped', 'running', 'missing'] as const)('reconciles a %s voyage on restart', status => {
    const todo = setup();
    todos.claim(todo.id, 'run-1');
    if (status !== 'missing') db.insertRun({ id: 'run-1', ticketId: todo.id, repo: todo.repo, adapter: 'codex', status, attempt: 1, prNumber: null, startedAt: '2026-09-18', endedAt: null, costUsd: null, worktreePath: null } satisfies RunRow);
    reconcileTodoRuns(todos, db);
    expect(todos.get(todo.id)?.state).toBe(status === 'running' ? 'in_progress' : status === 'succeeded' ? 'in_review' : 'blocked');
  });
});
