import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { LOCAL_POLL_MS } from './data/live';
import type { Todo } from './data/todos';

const views: DashboardView[] = [];
const json = (value: unknown) => Response.json(value);
const initialTodo: Todo = {
  id: 'TODO-1', title: 'Original requirement', repo: 'org/a', description: 'Implement the behavior.',
  acceptanceCriteria: 'Tests pass.', priority: 'P2', state: 'todo',
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', completedAt: null, runId: null,
};

async function setup(path = '/todos?repo=org/a', enabled = false) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadDashboard();
  let jiraEnabled = enabled;
  let todos = [{ ...initialTodo }];
  const holds = new Map<string, { started: () => void; wait: Promise<void> }>();
  const reads: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const deferRead = (path: string) => {
    let started!: () => void;
    let release!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    holds.set(path, { started, wait });
    return { started: start, release };
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      writes.push({ path: url.pathname, body });
      if (url.pathname === '/api/config') {
        jiraEnabled = body.value !== 'false';
        return json({ ok: true });
      }
      if (url.pathname === '/api/todos') {
        const created = { ...initialTodo, ...body, id: 'TODO-2' } as Todo;
        todos = [...todos, created];
        return json({ todo: created });
      }
      if (url.pathname === '/api/todos/TODO-1') {
        if (method === 'DELETE') {
          todos = todos.filter(todo => todo.id !== 'TODO-1');
          return json({ ok: true });
        }
        const changed = { ...initialTodo, ...body } as Todo;
        todos = todos.map(todo => todo.id === changed.id ? changed : todo);
        return json({ todo: changed });
      }
      throw new Error(`Unexpected write ${method} ${url.pathname}`);
    }
    reads.push(url.pathname);
    const data: unknown = url.pathname === '/api/context' ? { repos: ['org/a'], jiraEnabled, jiraBaseUrl: jiraEnabled ? 'https://jira.example.com' : null }
      : url.pathname === '/api/config' ? { config: { JIRA_ENABLED: String(jiraEnabled) }, overridden: [] }
      : url.pathname === '/api/todos' ? { todos, jiraEnabled }
      : url.pathname === '/api/dashboard' ? { snapshot, degraded: [], repos: ['org/a'], selectedRepo: url.searchParams.get('repo'), jiraEnabled, jiraBaseUrl: null }
      : url.pathname === '/api/agents' ? { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }
      : url.pathname === '/api/slack' ? { health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] }
      : url.pathname === '/api/triage' ? { groups: { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] }, degraded: false, selectedRepo: 'org/a', jiraBaseUrl: 'https://jira.example.com' }
      : url.pathname === '/api/bugs' ? { cards: [], degraded: false, generatedAt: '', latestWindow: '', previousWindow: '' }
      : url.pathname === '/api/repo/local' ? { repo: 'org/a', path: null, branches: [], worktrees: [], error: null }
      : { prs: [], degraded: false, truncated: false };
    const response = json(data);
    const hold = holds.get(url.pathname);
    if (hold) {
      holds.delete(url.pathname);
      hold.started();
      await hold.wait;
    }
    return response;
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  const click = (selector: string) => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    button!.click();
  };
  return { root, view, reads, writes, click, deferRead, setJiraEnabled: (value: boolean) => { jiraEnabled = value; } };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('source and todo response ordering', () => {
  it.each(['create', 'edit', 'delete'] as const)('does not let a delayed todo poll undo a completed %s', async operation => {
    const { root, view, click, deferRead } = await setup();
    if (operation === 'edit') click('[data-todo-edit=TODO-1]');
    const delayed = deferRead('/api/todos');
    const refreshing = view.refresh();
    await delayed.started;
    if (operation === 'delete') {
      click('[data-todo-delete=TODO-1]');
      click('[data-todo-confirm-delete=TODO-1]');
      await vi.waitFor(() => expect(root.querySelector('.todo-item')).toBeNull());
    } else {
      const title = root.querySelector<HTMLInputElement>('[data-todo-form] [name=title]')!;
      title.value = 'Latest saved requirement';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector<HTMLFormElement>('[data-todo-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(root.querySelector('[data-todo-list]')?.textContent).toContain('Latest saved requirement'));
    }
    delayed.release();
    await refreshing;
    if (operation === 'delete') expect(root.querySelector('.todo-item')).toBeNull();
    else expect(root.querySelector('[data-todo-list]')?.textContent).toContain('Latest saved requirement');
    expect(root.querySelector('[data-todo-list]')?.textContent).not.toContain('Loading todos');
    expect(root.querySelector<HTMLButtonElement>('[data-todo-refresh]')?.disabled).toBe(false);
  });

  it('does not let an old config/context refresh revert a saved Jira toggle', async () => {
    const { root, view, click, deferRead } = await setup('/config?repo=org/a', true);
    const delayed = deferRead('/api/context');
    const oldRefresh = view.refresh();
    await delayed.started;
    const source = root.querySelector<HTMLSelectElement>('.config-row[data-key=JIRA_ENABLED] .config-input')!;
    source.value = 'false';
    click('.config-save[data-key=JIRA_ENABLED]');
    await vi.waitFor(() => expect(root.querySelector('[data-view=todos]')).not.toBeNull());
    delayed.release();
    await oldRefresh;
    await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>('.config-row[data-key=JIRA_ENABLED] .config-input')?.value).toBe('false'));
    expect(root.querySelector('[data-view=triage], [data-view=bugs]')).toBeNull();
    click('[data-view=todos]');
    await vi.waitFor(() => expect(root.querySelector('[data-page=todos]')).not.toBeNull());
  });

  it.each(['/triage?repo=org/a', '/bugs?repo=org/a'])('redirects %s when another window disables Jira during ordinary polling', async path => {
    const { root, view, reads, setJiraEnabled } = await setup(path, true);
    const initialConfigReads = reads.filter(path => path === '/api/config').length;
    const initialDashboardReads = reads.filter(path => path === '/api/dashboard').length;
    setJiraEnabled(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOCAL_POLL_MS + 1);
    await view.refresh(false);
    expect(root.querySelector('[data-page=todos]')).not.toBeNull();
    expect(root.querySelector('[data-view=triage], [data-view=bugs]')).toBeNull();
    expect(window.location.pathname).toBe('/todos');
    expect(reads.filter(path => path === '/api/config')).toHaveLength(initialConfigReads);
    expect(reads.filter(path => path === '/api/dashboard')).toHaveLength(initialDashboardReads);
  });

  it('redirects Todos when another window reenables Jira', async () => {
    const { root, view, setJiraEnabled } = await setup();
    setJiraEnabled(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOCAL_POLL_MS + 1);
    await view.refresh(false);
    expect(root.querySelector('[data-page=config]')).not.toBeNull();
    expect(root.querySelector('[data-view=todos]')).toBeNull();
    expect(window.location.pathname).toBe('/config');
  });
});
