import { TODO_PRIORITIES, TODO_STATES, type Todo, type TodoInput } from './todos';

export interface TodosResponse {
  todos: Todo[];
  jiraEnabled: boolean;
}

export function isTodo(value: unknown): value is Todo {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Todo>;
  return typeof item.id === 'string' && Boolean(item.id)
    && typeof item.title === 'string' && typeof item.repo === 'string'
    && typeof item.description === 'string' && typeof item.acceptanceCriteria === 'string'
    && TODO_PRIORITIES.some(priority => priority === item.priority)
    && TODO_STATES.some(state => state === item.state)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
    && (item.completedAt === null || typeof item.completedAt === 'string' && Number.isFinite(Date.parse(item.completedAt)))
    && (item.runId === null || typeof item.runId === 'string');
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload: unknown = await response.json().catch(() => null);
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Todo request failed (${response.status}).`);
  if (!data) throw new Error('Unexpected todo response. Refresh and try again.');
  return data;
}

export async function fetchTodos(): Promise<TodosResponse> {
  const data = await request('/api/todos');
  if (!Array.isArray(data.todos) || !data.todos.every(isTodo) || typeof data.jiraEnabled !== 'boolean') {
    throw new Error('Unable to read the todo list. Refresh and try again.');
  }
  return { todos: data.todos, jiraEnabled: data.jiraEnabled };
}

async function saveTodo(path: string, method: 'POST' | 'PUT', input: TodoInput): Promise<Todo> {
  const data = await request(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!isTodo(data.todo)) throw new Error('Unable to confirm the saved todo. Refresh before retrying.');
  return data.todo;
}

export function createTodo(input: TodoInput): Promise<Todo> {
  return saveTodo('/api/todos', 'POST', input);
}

export function updateTodo(id: string, input: TodoInput): Promise<Todo> {
  return saveTodo(`/api/todos/${encodeURIComponent(id)}`, 'PUT', input);
}

export async function deleteTodo(id: string): Promise<void> {
  const data = await request(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (data.ok !== true) throw new Error('Unable to confirm deletion. Refresh before retrying.');
}
