import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { Todo } from './data/todos';

const views: DashboardView[] = [];
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const todo = (overrides: Partial<Todo> = {}): Todo => ({
  id: 'TODO-1', title: 'Improve search', repo: 'org/a', description: 'Include descriptions in search.',
  acceptanceCriteria: 'Find matching descriptions.', priority: 'P2', state: 'todo',
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', runId: null, completedAt: null, ...overrides,
});

async function setup(options: { path?: string; jiraEnabled?: boolean; items?: Todo[]; launchError?: string; autoClaimError?: boolean } = {}) {
  window.history.replaceState(null, '', options.path ?? '/todos?repo=org/a');
  const snapshot = await loadDashboard();
  let jiraEnabled = options.jiraEnabled ?? false;
  let todos = options.items ?? [todo()];
  let autoClaim: string[] = [];
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      writes.push({ path: url.pathname, method, body });
      if (url.pathname === '/api/config') {
        jiraEnabled = body.value !== 'false';
        return json({ ok: true });
      }
      if (url.pathname === '/api/todos' && method === 'POST') {
        const created = todo({ ...body, id: 'TODO-2' } as Partial<Todo>);
        todos.push(created);
        return json({ todo: created });
      }
      if (url.pathname.startsWith('/api/todos/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        if (method === 'DELETE') {
          todos = todos.filter(item => item.id !== id);
          return json({ ok: true });
        }
        const edited = todo({ ...todos.find(item => item.id === id), ...body } as Partial<Todo>);
        todos = todos.map(item => item.id === id ? edited : item);
        return json({ todo: edited });
      }
      if (url.pathname === '/api/agents/launch') {
        if (options.launchError) return json({ error: options.launchError }, 409);
        todos = todos.map(item => item.id === body.todoId ? { ...item, state: 'in_progress', runId: 'run-123' } : item);
        return json({ runId: 'run-123' });
      }
      if (url.pathname === '/api/repos/org%2Fa/auto-claim') {
        if (options.autoClaimError) return json({ error: 'Unable to update auto-claim.' }, 500);
        autoClaim = body.enabled ? ['org/a'] : [];
        return json({ ok: true });
      }
      throw new Error(`Unexpected write ${method} ${url.pathname}`);
    }
    reads.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null, jiraEnabled });
    if (url.pathname === '/api/todos') return json({ todos, jiraEnabled });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim, caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: { JIRA_ENABLED: String(jiraEnabled) }, overridden: [] });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  const click = (selector: string) => {
    const button = root.querySelector<HTMLElement>(selector);
    expect(button, selector).not.toBeNull();
    button!.click();
  };
  const fill = (name: string, value: string) => {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-todo-form] [name="${name}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const submit = () => root.querySelector<HTMLFormElement>('[data-todo-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return { root, view, writes, reads, click, fill, submit, resetAutoClaim: () => { autoClaim = []; } };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('todo workflow', () => {
  it('enables and disables automatic voyages for the selected repository', async () => {
    const { root, writes, click, fill, view } = await setup();
    fill('title', 'Keep this draft ');
    expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('false');
    click('[data-todo-auto-claim]');
    await vi.waitFor(() => expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('true'));
    expect(root.querySelector('[data-todo-auto-claim]')?.textContent).toBe('Stop automatic starts');
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe('Keep this draft ');
    await view.refresh();
    expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('true');
    click('[data-todo-auto-claim]');
    await vi.waitFor(() => expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('false'));
    expect(writes).toEqual([
      { path: '/api/repos/org%2Fa/auto-claim', method: 'POST', body: { enabled: true } },
      { path: '/api/repos/org%2Fa/auto-claim', method: 'POST', body: { enabled: false } },
    ]);
  });

  it('keeps automatic voyages off after a failed opt-in', async () => {
    const { root, click } = await setup({ autoClaimError: true });
    click('[data-todo-auto-claim]');
    await vi.waitFor(() => expect(root.querySelector('[data-todo-feedback] [role=alert]')?.textContent).toBe('Unable to update auto-claim.'));
    expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('[data-todo-auto-claim]')?.disabled).toBe(false);
  });

  it('reflects a server-side auto-claim reset without replacing the draft', async () => {
    const { root, click, fill, view, resetAutoClaim } = await setup();
    click('[data-todo-auto-claim]');
    await vi.waitFor(() => expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('true'));
    fill('title', 'Draft across server restart');
    resetAutoClaim();
    await view.refresh();
    expect(root.querySelector('[data-todo-auto-claim]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('[data-todo-auto-claim]')?.textContent).toBe('Start todos automatically');
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe('Draft across server restart');
  });

  it('opens the direct Todos link and replaces Jira-specific navigation', async () => {
    const { root, reads } = await setup();
    expect(root.querySelector('[data-page=todos]')).not.toBeNull();
    expect(document.title).toBe('Todos · Helmsman');
    expect(root.querySelector('[data-view=todos]')).not.toBeNull();
    expect(root.querySelector('[data-view=triage], [data-view=bugs]')).toBeNull();
    expect(reads).not.toContain('/api/triage');
    expect(root.querySelector('.todo-item h3')?.textContent).toBe('Improve search');
  });

  it('switches from Jira to Todos in Config and defaults new voyages to free-form', async () => {
    const { root, writes, click } = await setup({ path: '/config?repo=org/a', jiraEnabled: true });
    expect(root.querySelector('[data-view=todos]')).toBeNull();
    const select = root.querySelector<HTMLSelectElement>('.config-row[data-key=JIRA_ENABLED] .config-input')!;
    select.value = 'false';
    click('.config-save[data-key=JIRA_ENABLED]');
    await vi.waitFor(() => expect(root.querySelector('[data-view=todos]')).not.toBeNull());
    expect(root.querySelector('[data-view=triage], [data-view=bugs]')).toBeNull();
    expect(writes[0]).toEqual({ path: '/api/config', method: 'PUT', body: { key: 'JIRA_ENABLED', value: 'false' } });
    await vi.waitFor(() => expect(root.querySelector('.config-row[data-key=JIRA_ENABLED] .config-save')?.hasAttribute('disabled')).toBe(false));
    click('[data-view=dashboard]');
    await vi.waitFor(() => expect(root.querySelector('[data-page=dashboard]')).not.toBeNull());
    expect(root.querySelector('.newrun-ticket')).toBeNull();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.newrun-mode[value=freeform]')?.checked).toBe(true));
  });

  it('follows the header repository for a new todo after its title has been drafted', async () => {
    const { root, view, writes, fill, submit } = await setup({ items: [] });
    fill('title', 'Keep the drafted title');
    fill('description', 'Use the currently selected repository.');
    const header = root.querySelector<HTMLSelectElement>('.repo-select')!;
    header.value = 'org/b';
    header.dispatchEvent(new Event('change', { bubbles: true }));
    await view.refresh();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('[data-todo-form] [name=repo]')?.value).toBe('org/b'));
    expect(root.querySelector<HTMLInputElement>('[data-todo-form] [name=title]')?.value).toBe('Keep the drafted title');
    submit();
    await vi.waitFor(() => expect(writes).toContainEqual(expect.objectContaining({
      path: '/api/todos', method: 'POST', body: expect.objectContaining({ repo: 'org/b', title: 'Keep the drafted title' }),
    })));
  });

  it('preserves an explicit new-todo repository override when the header changes', async () => {
    const { root, view, writes, fill, submit } = await setup({ items: [] });
    fill('title', 'Keep the explicit target');
    fill('description', 'This task belongs to repository A.');
    fill('repo', 'org/a');
    const header = root.querySelector<HTMLSelectElement>('.repo-select')!;
    header.value = 'org/b';
    header.dispatchEvent(new Event('change', { bubbles: true }));
    await view.refresh();
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    expect(root.querySelector<HTMLInputElement>('[data-todo-form] [name=repo]')?.value).toBe('org/a');
    submit();
    await vi.waitFor(() => expect(writes).toContainEqual(expect.objectContaining({
      path: '/api/todos', method: 'POST', body: expect.objectContaining({ repo: 'org/a', title: 'Keep the explicit target' }),
    })));
  });

  it('keeps an edited todo assigned to its saved repository when the header changes', async () => {
    const { root, view, writes, click, fill, submit } = await setup();
    click('[data-todo-edit=TODO-1]');
    fill('title', 'Edited in repository A');
    const header = root.querySelector<HTMLSelectElement>('.repo-select')!;
    header.value = 'org/b';
    header.dispatchEvent(new Event('change', { bubbles: true }));
    await view.refresh();
    expect(root.querySelector<HTMLInputElement>('[data-todo-form] [name=repo]')?.value).toBe('org/a');
    submit();
    await vi.waitFor(() => expect(writes).toContainEqual(expect.objectContaining({
      path: '/api/todos/TODO-1', method: 'PUT', body: expect.objectContaining({ repo: 'org/a', title: 'Edited in repository A' }),
    })));
  });

  it('creates and edits a todo with its voyage details', async () => {
    const { root, writes, fill, submit, click } = await setup({ items: [] });
    fill('title', 'Improve keyboard navigation');
    fill('description', 'All todo actions should be accessible by keyboard.');
    fill('acceptanceCriteria', 'Tab order follows reading order.');
    fill('priority', 'P1');
    submit();
    await vi.waitFor(() => expect(root.querySelector('.todo-item h3')?.textContent).toBe('Improve keyboard navigation'));
    expect(writes[0]).toEqual({ path: '/api/todos', method: 'POST', body: {
      title: 'Improve keyboard navigation', repo: 'org/a', description: 'All todo actions should be accessible by keyboard.',
      acceptanceCriteria: 'Tab order follows reading order.', priority: 'P1', state: 'todo',
    } });
    click('[data-todo-edit=TODO-2]');
    fill('state', 'blocked');
    fill('title', 'Waiting for keyboard design');
    submit();
    await vi.waitFor(() => expect(root.querySelector('.todo-item h3')?.textContent).toBe('Waiting for keyboard design'));
    expect(writes[1]).toMatchObject({ path: '/api/todos/TODO-2', method: 'PUT', body: { state: 'blocked' } });
  });

  it('does not delete until the specific todo is confirmed', async () => {
    const { root, writes, click } = await setup();
    click('[data-todo-delete=TODO-1]');
    expect(writes).toEqual([]);
    click('[data-todo-cancel-delete]');
    expect(root.querySelector('[data-todo-confirm-delete]')).toBeNull();
    click('[data-todo-delete=TODO-1]');
    click('[data-todo-confirm-delete=TODO-1]');
    await vi.waitFor(() => expect(root.querySelector('.todo-item')).toBeNull());
    expect(writes).toEqual([{ path: '/api/todos/TODO-1', method: 'DELETE', body: {} }]);
  });

  it('keeps the in-progress draft and input focus through search and background refresh', async () => {
    const { root, view, fill } = await setup();
    fill('title', 'New draft ');
    fill('description', 'Some unsubmitted context\n');
    const search = root.querySelector<HTMLInputElement>('[data-todo-search]')!;
    search.focus();
    search.value = 'missing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.todo-item')).toBeNull();
    expect(document.activeElement).toBe(search);
    await view.refresh();
    expect(document.activeElement).toBe(search);
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe('New draft ');
    expect(root.querySelector<HTMLTextAreaElement>('[name=description]')?.value).toBe('Some unsubmitted context\n');
    expect(search.value).toBe('missing');
  });

  it('launches the saved todo and locks its active voyage', async () => {
    const { root, writes, click } = await setup();
    click('[data-todo-launch=TODO-1]');
    await vi.waitFor(() => expect(root.querySelector('.todo-state')?.textContent).toBe('In progress'));
    expect(writes).toEqual([{ path: '/api/agents/launch', method: 'POST', body: { mode: 'todo', todoId: 'TODO-1', repo: 'org/a' } }]);
    expect(root.querySelector<HTMLButtonElement>('[data-todo-edit=TODO-1]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-todo-launch=TODO-1]')?.disabled).toBe(true);
    expect(root.querySelector('.todo-run-link')?.getAttribute('href')).toContain('run=run-123');
  });

  it('shows launch failures without losing the saved todo or draft', async () => {
    const { root, fill, click } = await setup({ launchError: 'No local checkout configured.' });
    fill('title', 'Draft to keep');
    click('[data-todo-launch=TODO-1]');
    await vi.waitFor(() => expect(root.querySelector('[data-todo-feedback] [role=alert]')?.textContent).toBe('No local checkout configured.'));
    expect(root.querySelector<HTMLInputElement>('[name=title]')?.value).toBe('Draft to keep');
    expect(root.querySelector('.todo-state')?.textContent).toBe('To do');
    expect(root.querySelector<HTMLButtonElement>('[data-todo-launch=TODO-1]')?.disabled).toBe(false);
  });
});
