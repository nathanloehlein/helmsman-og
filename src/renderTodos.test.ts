import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPirateMode } from './logic/terminology';
import type { Todo } from './data/todos';
import { readTodoForm, renderTodos, type TodosViewState } from './renderTodos';

const item = (overrides: Partial<Todo> = {}): Todo => ({
  id: 'TODO-1', title: 'Improve search', repo: 'owner/repo', description: 'Search should include descriptions.',
  acceptanceCriteria: 'Results include matching descriptions.', priority: 'P2', state: 'todo',
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', runId: null, completedAt: null, ...overrides,
});

function render(overrides: Partial<TodosViewState> = {}, selectedRepo: string | null = null): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = renderTodos({ items: [], loading: false, error: null, search: '', stateFilter: 'all', ...overrides }, {
    repos: ['owner/repo'], selectedRepo, themeId: 'quarterdeck',
  });
  return root;
}

beforeEach(() => setPirateMode(true));
afterEach(() => localStorage.removeItem('helmsman.pirateMode'));

describe('todo rendering', () => {
  it.each([true, false])('switches task terminology while preserving saved text and form state (%s)', pirate => {
    setPirateMode(pirate);
    const title = 'Review PR with crew on a voyage';
    const root = render({ items: [item({ title, state: 'in_review', runId: 'run-123' })], draft: { title, state: 'in_review' } }, 'owner/repo');
    expect(root.querySelector('[name=repo]')?.parentElement?.textContent).toBe(pirate ? 'Galleon' : 'Repository');
    expect(root.querySelector('[data-todo-launch]')?.textContent).toBe(pirate ? 'Weigh anchor' : 'Start run');
    expect(root.querySelector('.todo-state')?.textContent).toBe(pirate ? 'In inspection' : 'In review');
    expect(root.querySelector('.todo-item h3')?.textContent).toBe(title);
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe(title);
    expect(root.querySelector<HTMLSelectElement>('[name=state]')?.value).toBe('in_review');
    expect(root.querySelector('.todo-run-link')?.textContent).toBe(pirate ? 'View voyage ↗' : 'View run ↗');
    expect(root.querySelector('.todo-run-link')?.getAttribute('href')).toContain('run=run-123');
    if (!pirate) expect(root.querySelector('.todos-intro')?.textContent).not.toMatch(/voyage|galleon|crew/i);
  });

  it('provides the voyage task drawer slot for launch logs', () => {
    expect(render().querySelector('.runs-drawer-slot[data-pane=tasks]')).not.toBeNull();
  });

  it('offers opt-in automatic voyages only within a repository scope', () => {
    expect(render().querySelector('[data-todo-auto-claim]')).toBeNull();
    const scoped = render({}, 'owner/repo');
    expect(scoped.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('false');
    expect(scoped.textContent).toContain('Resets when server restarts');
    const root = document.createElement('div');
    root.innerHTML = renderTodos({ items: [], loading: false, error: null, search: '', stateFilter: 'all' }, {
      repos: ['owner/repo'], selectedRepo: 'owner/repo', themeId: 'quarterdeck', autoClaimEnabled: true,
    });
    expect(root.querySelector('[data-todo-auto-claim]')?.textContent).toBe('Stop automatic starts');
    expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('creates a scoped draft with P2 priority and a guided launch description', () => {
    const root = render({}, 'owner/repo');
    const form = root.querySelector<HTMLFormElement>('[data-todo-form]')!;
    expect(readTodoForm(form)).toEqual({ title: '', repo: 'owner/repo', description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo' });
    expect(form.querySelector<HTMLInputElement>('[name=title]')?.required).toBe(true);
    expect(form.querySelector<HTMLInputElement>('[name=repo]')?.required).toBe(true);
    expect(root.textContent).toContain('Required to start a voyage');
    expect(root.querySelector<HTMLOptionElement>('option[value=in_progress]')?.disabled).toBe(true);
  });

  it('sorts by priority, then oldest first, and scopes by repository', () => {
    const root = render({ items: [
      item({ id: 'TODO-4', priority: 'P4' }), item({ id: 'TODO-3', priority: 'P0' }),
      item({ id: 'TODO-2', priority: 'P0', createdAt: '2026-09-17T12:00:00Z' }),
      item({ id: 'TODO-other', priority: 'P0', repo: 'other/repo' }),
    ] }, 'owner/repo');
    expect(Array.from(root.querySelectorAll('.todo-item')).map(row => row.getAttribute('data-todo-id'))).toEqual(['TODO-2', 'TODO-3', 'TODO-4']);
    expect(root.querySelector('.todo-list-summary')?.textContent).toContain('3 of 3');
  });

  it('combines case-insensitive context search with the state filter', () => {
    const root = render({ search: 'EDGE CASE', stateFilter: 'blocked', items: [
      item({ id: 'TODO-1', state: 'blocked', acceptanceCriteria: 'Handle the edge case' }),
      item({ id: 'TODO-2', state: 'todo', description: 'Handle the edge case' }),
    ] });
    expect(root.querySelectorAll('.todo-item')).toHaveLength(1);
    expect(root.querySelector('.todo-item')?.getAttribute('data-todo-id')).toBe('TODO-1');
  });

  it('allows launches only for described todos and locks active todos', () => {
    const root = render({ items: [item(), item({ id: 'draft', description: '' }), item({ id: 'active', state: 'in_progress', runId: 'run-123' }), item({ id: 'done', state: 'done' })] });
    expect(root.querySelector<HTMLButtonElement>('[data-todo-launch="TODO-1"]')?.disabled).toBe(false);
    for (const id of ['draft', 'active', 'done']) expect(root.querySelector<HTMLButtonElement>(`[data-todo-launch="${id}"]`)?.disabled).toBe(true);
    for (const action of ['edit', 'delete']) expect(root.querySelector<HTMLButtonElement>(`[data-todo-${action}="active"]`)?.disabled).toBe(true);
    const href = root.querySelector('.todo-run-link')?.getAttribute('href');
    expect(new URL(href ?? '', 'http://localhost').searchParams.get('run')).toBe('run-123');
  });

  it('preserves an unsaved edit draft and reads all voyage input fields', () => {
    const root = render({ items: [item()], editingId: 'TODO-1', draft: { title: ' Updated title ', repo: 'owner/other', description: 'Describe the change', acceptanceCriteria: 'Tests pass', priority: 'P1', state: 'blocked' } });
    const form = root.querySelector<HTMLFormElement>('[data-todo-form]')!;
    expect(form.getAttribute('data-todo-id')).toBe('TODO-1');
    expect(readTodoForm(form)).toEqual({ title: ' Updated title ', repo: 'owner/other', description: 'Describe the change', acceptanceCriteria: 'Tests pass', priority: 'P1', state: 'blocked' });
  });

  it.each([null, 'owner/repo'])('preserves header scope %s when opening a todo voyage', selectedRepo => {
    const root = render({ items: [item({ runId: 'run-123' })] }, selectedRepo);
    const href = root.querySelector('.todo-run-link')?.getAttribute('href');
    const params = new URL(href ?? '', 'http://localhost').searchParams;
    expect(params.get('repo')).toBe(selectedRepo);
    expect(params.get('run')).toBe('run-123');
  });

  it('requires a separate confirmation before deleting a todo', () => {
    const root = render({ items: [item()], deletingId: 'TODO-1' });
    expect(root.querySelector('[data-todo-confirm-delete]')?.getAttribute('data-todo-confirm-delete')).toBe('TODO-1');
    expect(root.querySelector('[data-todo-cancel-delete]')?.textContent).toBe('Keep todo');
    expect(render({ items: [item()] }).querySelector('[data-todo-confirm-delete]')).toBeNull();
  });

  it('escapes untrusted todo text, drafts, search, and errors', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const root = render({ items: [item({ id: payload, title: payload, description: payload, acceptanceCriteria: payload, repo: payload })], error: payload, draft: { title: payload, description: '</textarea><script>alert(1)</script>' }, search: payload });
    expect(root.querySelector('img, script')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe(payload);
    expect(root.querySelector('[role=alert]')?.textContent).toBe(payload);
    expect(root.querySelector('.todo-item h3')?.textContent).toBe(payload);
  });

  it('shows failed loads without claiming an empty backlog', () => {
    const root = render({ error: 'Network unavailable' });
    expect(root.textContent).toContain('Refresh to load the todo list.');
    expect(root.textContent).not.toContain('No todos yet.');
    expect(root.querySelector<HTMLButtonElement>('[data-todo-refresh]')?.disabled).toBe(false);
  });

  it('disables mutations while a save is pending', () => {
    const root = render({ items: [item()], pendingAction: 'Saving todo…' });
    expect(root.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-todo-launch]')?.disabled).toBe(true);
    expect(root.querySelector('[role=status]')?.textContent).toBe('Saving todo…');
  });
});
