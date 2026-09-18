import type { Todo } from '../../src/data/todos';
import type { AgentTask } from './agents/adapter';
import type { Db } from './db';
import type { TodoStore } from './todos';

export function todoTask(todo: Todo): AgentTask {
  return {
    todoId: todo.id,
    ticketId: todo.id,
    title: todo.title,
    repo: todo.repo,
    jiraBaseUrl: '',
    task: [
      `${todo.id}: ${todo.title}`,
      `Priority: ${todo.priority}`,
      `Description:\n${todo.description}`,
      ...(todo.acceptanceCriteria ? [`Acceptance criteria:\n${todo.acceptanceCriteria}`] : []),
      'This is a local Helmsman todo. All task requirements are included above; do not read or update Jira.',
    ].join('\n\n'),
  };
}

export function reconcileTodoRuns(todos: TodoStore, db: Pick<Db, 'getRun'>): void {
  for (const todo of todos.list()) {
    if (todo.state !== 'in_progress' || !todo.runId) continue;
    const run = db.getRun(todo.runId);
    if (run?.status === 'running') continue;
    todos.finishRun(todo.runId, run?.status ?? 'failed');
  }
}
