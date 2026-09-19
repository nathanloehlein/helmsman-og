import type { AppConfig } from '../config';
import type { Todo } from '../../src/data/todos';

export function repositoryScope(
  config: Pick<AppConfig, 'repoProjectMap' | 'github' | 'jiraEnabled'>,
  todos: readonly Pick<Todo, 'repo'>[],
): string[] {
  return [...new Set([
    ...Object.keys(config.repoProjectMap),
    ...(config.github?.repo ? [config.github.repo] : []),
    ...(!config.jiraEnabled ? todos.map(todo => todo.repo) : []),
  ])].sort();
}
