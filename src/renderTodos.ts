import { TODO_PRIORITIES, TODO_STATES, type Todo, type TodoInput, type TodoState } from './data/todos';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import { term } from './logic/terminology';
import { renderAppShell } from './render';
import './todos.css';

export interface TodosViewState {
  items: Todo[];
  loading: boolean;
  error: string | null;
  search: string;
  stateFilter: 'all' | TodoState;
  editingId?: string | null;
  deletingId?: string | null;
  draft?: Partial<TodoInput>;
  pendingAction?: string;
}

export interface TodosViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  autoClaimEnabled?: boolean;
}

const stateLabels = (): Record<TodoState, string> => ({
  todo: 'To do', in_progress: 'In progress', in_review: term('inReview'), done: 'Done', blocked: 'Blocked',
});
const PRIORITY_LABELS = ['Critical', 'High', 'Normal', 'Low', 'Backlog'];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const items = (state: TodosViewState): Todo[] => (Array.isArray(state?.items) ? state.items : [])
  .filter(item => item && typeof item.id === 'string' && typeof item.title === 'string');

function options(values: readonly string[], selected: string, labels?: Record<string, string>): string {
  return values.map(value => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(labels?.[value] ?? value)}</option>`).join('');
}

export function readTodoForm(form: HTMLFormElement): TodoInput {
  const data = new FormData(form);
  const priority = data.get('priority');
  const state = data.get('state');
  return {
    title: text(data.get('title')), repo: text(data.get('repo')),
    description: text(data.get('description')), acceptanceCriteria: text(data.get('acceptanceCriteria')),
    priority: TODO_PRIORITIES.find(value => value === priority) ?? 'P2',
    state: TODO_STATES.find(value => value === state) ?? 'todo',
  };
}

function renderForm(state: TodosViewState, opts: TodosViewOpts): string {
  const selected = items(state).find(item => item.id === state.editingId);
  const draft = state.draft ?? selected ?? {};
  const repo = draft.repo ?? opts.selectedRepo ?? '';
  const busy = Boolean(state.pendingAction) || selected?.state === 'in_progress';
  const priorities = Object.fromEntries(TODO_PRIORITIES.map((priority, i) => [priority, `${priority} · ${PRIORITY_LABELS[i]}`]));
  return `<section class="panel todo-editor" aria-labelledby="todo-editor-title">
    <div class="panel-head"><span class="panel-title" id="todo-editor-title">${selected ? 'Edit todo' : 'New todo'}</span>${selected ? '<button type="button" class="todo-button" data-todo-new>New todo</button>' : ''}</div>
    <form data-todo-form${selected ? ` data-todo-id="${esc(selected.id)}"` : ''}>
      <fieldset${busy ? ' disabled' : ''}>
        <label class="todo-field">Title<input name="title" required maxlength="240" placeholder="What should the ${term('crew').toLowerCase()} deliver?" value="${esc(text(draft.title))}"></label>
        <label class="todo-field">${term('repository')}<input name="repo" required list="todo-repositories" pattern="[A-Za-z0-9_\\x2d][A-Za-z0-9_.\\x2d]*\\x2f[A-Za-z0-9_\\x2d][A-Za-z0-9_.\\x2d]*" placeholder="owner/name" value="${esc(repo)}"><datalist id="todo-repositories">${(opts.repos ?? []).map(repo => `<option value="${esc(repo)}"></option>`).join('')}</datalist></label>
        <div class="todo-form-row"><label class="todo-field">Priority<select name="priority">${options(TODO_PRIORITIES, draft.priority ?? 'P2', priorities)}</select></label>
        <label class="todo-field">State<select name="state">${TODO_STATES.map(value => `<option value="${value}"${value === (draft.state ?? 'todo') ? ' selected' : ''}${value === 'in_progress' ? ' disabled' : ''}>${stateLabels()[value]}${value === 'in_progress' ? ` · ${term('run').toLowerCase()} managed` : ''}</option>`).join('')}</select></label></div>
        <label class="todo-field">Description<textarea name="description" aria-describedby="todo-description-help" rows="5" maxlength="20000" placeholder="Describe the problem, expected behavior, and relevant files or context.">${esc(text(draft.description))}</textarea><span class="todo-field-hint" id="todo-description-help">Required to start a ${term('run').toLowerCase()}. You can save a draft first.</span></label>
        <label class="todo-field">Acceptance criteria (optional)<textarea name="acceptanceCriteria" rows="4" maxlength="20000" placeholder="How will we know this is done? Include tests, edge cases, and constraints.">${esc(text(draft.acceptanceCriteria))}</textarea></label>
        <div class="todo-actions"><button class="todo-button todo-button-primary" type="submit">${selected ? 'Save changes' : 'Add todo'}</button>${selected ? '<button class="todo-button" type="button" data-todo-cancel>Cancel</button>' : ''}</div>
      </fieldset>
    </form>
  </section>`;
}

function renderItem(item: Todo, state: TodosViewState, selectedRepo: string | null): string {
  const active = item.state === 'in_progress';
  const busy = Boolean(state.pendingAction);
  const reason = active ? `A ${term('run').toLowerCase()} is already working on this todo.`
    : item.state !== 'todo' ? 'Set the state to To do before launching.'
    : !text(item.description).trim() ? 'Add a description before launching.' : '';
  const stateLabel = stateLabels()[item.state] ?? 'Unknown';
  const hintId = `todo-launch-help-${encodeURIComponent(item.id)}`;
  return `<li class="todo-item${state.editingId === item.id ? ' is-editing' : ''}" data-todo-id="${esc(item.id)}">
    <div class="todo-item-heading"><span class="todo-priority mono">${esc(text(item.priority))}</span><h3>${esc(item.title)}</h3><span class="todo-state">${esc(stateLabel)}</span></div>
    <div class="todo-item-meta mono">${esc(text(item.repo))}<span>${esc(item.id)}</span></div>
    ${item.description ? `<p class="todo-description">${esc(text(item.description))}</p>` : `<p class="todo-missing">Draft · add a description to make this todo ready for a ${term('run').toLowerCase()}.</p>`}
    ${item.acceptanceCriteria ? `<details class="todo-criteria"><summary>Acceptance criteria</summary><p>${esc(text(item.acceptanceCriteria))}</p></details>` : ''}
    <div class="todo-actions"><button class="todo-button todo-button-primary" type="button" data-todo-launch="${esc(item.id)}" aria-label="${term('launchRun')} for ${esc(item.id)}: ${esc(item.title)}"${reason ? ` aria-describedby="${esc(hintId)}"` : ''}${busy || reason ? ' disabled' : ''}${reason ? ` title="${esc(reason)}"` : ''}>${term('launchRun')}</button>
      <button class="todo-button" type="button" data-todo-edit="${esc(item.id)}" aria-label="Edit ${esc(item.id)}: ${esc(item.title)}"${busy || active ? ' disabled' : ''}>Edit</button>
      <button class="todo-button todo-button-delete" type="button" data-todo-delete="${esc(item.id)}" aria-label="Delete ${esc(item.id)}: ${esc(item.title)}"${busy || active ? ' disabled' : ''}>Delete</button>
      ${item.runId ? `<a class="app-link todo-run-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, run: item.runId }))}">View ${term('run').toLowerCase()} ↗</a>` : ''}
    </div>
    ${reason ? `<p class="todo-field-hint" id="${esc(hintId)}">${esc(active ? `${term('run')} in progress. Editing is available when it finishes.` : reason)}</p>` : ''}
    ${state.deletingId === item.id ? `<div class="todo-confirmation" role="region" aria-label="Confirm todo deletion"><strong>Delete this todo?</strong><p>This permanently removes the todo. Its ${term('run').toLowerCase()} history is kept.</p><div class="todo-actions"><button class="todo-button todo-button-delete" type="button" data-todo-confirm-delete="${esc(item.id)}"${busy || active ? ' disabled' : ''}>Confirm deletion</button><button class="todo-button" type="button" data-todo-cancel-delete${busy ? ' disabled' : ''}>Keep todo</button></div></div>` : ''}
  </li>`;
}

export function renderTodoList(state: TodosViewState, opts: TodosViewOpts): string {
  const scoped = items(state).filter(item => !opts.selectedRepo || item.repo === opts.selectedRepo);
  const search = text(state.search).trim().toLowerCase();
  const filtered = scoped.filter(item => (state.stateFilter === 'all' || item.state === state.stateFilter)
    && (!search || [item.title, item.description, item.acceptanceCriteria, item.repo, item.id].some(value => text(value).toLowerCase().includes(search))))
    .sort((a, b) => text(a.priority).localeCompare(text(b.priority)) || text(a.createdAt).localeCompare(text(b.createdAt)) || a.id.localeCompare(b.id));
  const empty = state.loading ? 'Loading todos…' : state.error ? 'Refresh to load the todo list.'
    : scoped.length ? 'No todos match these filters.' : `No todos yet. Add a todo with a ${term('repository').toLowerCase()} and description to plan your first ${term('run').toLowerCase()}.`;
  return `<div class="todo-list-summary" aria-live="polite">${filtered.length} of ${scoped.length} todo${scoped.length === 1 ? '' : 's'} · highest priority first</div>
    <ul class="todo-list">${filtered.length ? filtered.map(item => renderItem(item, state, opts.selectedRepo)).join('') : `<li class="empty-note">${empty}</li>`}</ul>`;
}

export function renderTodos(state: TodosViewState, opts: TodosViewOpts): string {
  return `<div class="todos-intro"><h1>Todos</h1><p>Plan tasks for your agents without a Jira ticket. Save a todo, then start a ${term('run').toLowerCase()} when it is ready.</p></div>
    <div class="todo-auto-claim">${opts.selectedRepo ? `<button class="todo-button" type="button" data-todo-auto-claim aria-pressed="${Boolean(opts.autoClaimEnabled)}"${state.pendingAction ? ' disabled' : ''}>${opts.autoClaimEnabled ? 'Stop automatic starts' : 'Start todos automatically'}</button><p>When enabled, todos in To do with a description start in priority order, one ${term('run').toLowerCase()} per ${term('repository').toLowerCase()}. Resets when server restarts.</p>` : `<p>Select a ${term('repository').toLowerCase()} to enable automatic ${term('runs').toLowerCase()} from its ready todos.</p>`}</div>
    <div data-todo-feedback>${state.error ? `<div class="todo-error" role="alert">${esc(state.error)}</div>` : ''}
    ${state.pendingAction ? `<p class="todo-notice" role="status">${esc(state.pendingAction)}</p>` : ''}</div>
    <div class="todos-layout">${renderForm(state, opts)}<section class="panel todo-backlog" aria-label="Todo backlog" aria-busy="${Boolean(state.loading || state.pendingAction)}">
      <div class="panel-head"><span class="panel-title">Backlog</span><button class="todo-button" type="button" data-todo-refresh${state.loading || state.pendingAction ? ' disabled' : ''}>Refresh</button></div>
      <div class="todo-filters"><label class="todo-field">Search<input type="search" data-todo-search value="${esc(text(state.search))}" placeholder="Title, description, or ${term('repository').toLowerCase()}"></label><label class="todo-field">State<select data-todo-state-filter><option value="all"${state.stateFilter === 'all' ? ' selected' : ''}>All states</option>${options(TODO_STATES, state.stateFilter, stateLabels())}</select></label></div>
      <div data-todo-list>${renderTodoList(state, opts)}</div>
    </section></div><div class="runs-drawer-slot" data-pane="tasks"></div>`;
}

export function renderTodosView(state: TodosViewState, opts: TodosViewOpts): string {
  return renderAppShell({ active: 'todos', ...opts, jiraEnabled: false, readout: null }, renderTodos(state, opts));
}
