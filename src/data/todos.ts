export const TODO_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export const TODO_STATES = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;

export type TodoPriority = typeof TODO_PRIORITIES[number];
export type TodoState = typeof TODO_STATES[number];

export interface TodoInput {
  title: string;
  repo: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TodoPriority;
  state?: TodoState;
}

export interface Todo {
  id: string;
  title: string;
  repo: string;
  description: string;
  acceptanceCriteria: string;
  priority: TodoPriority;
  state: TodoState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  runId: string | null;
}
