import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { SlackState } from './data/slack';

const json = (data: unknown): Response => new Response(JSON.stringify(data));
let view: DashboardView | undefined;
let state: SlackState;
let unavailable: boolean;
let readFails: boolean;
let clearHandler: (input: { repo: string | null; clearToken: string }) => Promise<Response>;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/helm');
  unavailable = false;
  readFails = false;
  state = {
    clearToken: `1:${'a'.repeat(64)}`,
    health: { enabled: true, status: 'healthy', channelName: 'airo-editing', intervalMs: 300_000, lastSuccessAt: null, error: null },
    notifications: [{ id: 'message-one', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42', sourceUrl: 'https://company.slack.com/archives/C123/p123456789', author: 'Alex', channelName: 'airo-editing', status: 'launched', runId: 'run-42', createdAt: '2026-09-17T12:00:00Z', updatedAt: '2026-09-17T12:00:00Z', readAt: null, error: null }],
  };
  clearHandler = async input => {
    const previous = state.notifications.length;
    state.notifications = state.notifications.filter(item => input.repo !== null && item.repo.toLowerCase() !== input.repo.toLowerCase());
    return json({ ok: true, ...input, cleared: previous - state.notifications.length });
  };
  const snapshot = await loadDashboard();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/notifications/clear') { expect(init?.method).toBe('POST'); return clearHandler(JSON.parse(String(init?.body))); }
    if (url.pathname === '/api/slack') {
      const repo = url.searchParams.get('repo');
      return unavailable ? new Response('', { status: 503 }) : json({ ...state, notifications: state.notifications.filter(item => !repo || item.repo.toLowerCase() === repo.toLowerCase()) });
    }
    const read = /^\/api\/slack\/notifications\/([a-z\d_-]+)\/read$/i.exec(url.pathname);
    if (read?.[1]) {
      expect(init?.method).toBe('POST');
      if (readFails) return new Response('', { status: 500 });
      state = { ...state, notifications: state.notifications.map(item => item.id === read[1] ? { ...item, readAt: new Date().toISOString() } : item) };
      return json({ ok: true });
    }
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo', 'org/other'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    throw new Error(`Unexpected request ${url}`);
  }));
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();

describe('persistent Slack notifications', () => {
  it('adds completed voyages during polling with Slack disabled and persists their read state', async () => {
    state = { health: { ...state.health, enabled: false, status: 'disabled' }, notifications: [] };
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    await view.start();
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('0 unread');
    state.notifications.push({ kind: 'voyage-completed', id: 'voyage-completed-one', repo: 'org/repo',
      title: 'Finish the requested change', prNumber: null, prUrl: '', sourceUrl: '/runs?run=run-complete',
      author: 'Helmsman', channelName: 'Helmsman voyages', status: 'succeeded', runId: 'run-complete',
      createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', readAt: null, error: null });
    await view.refresh();
    click('[data-slack-toggle]');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('1 unread');
    expect(document.querySelector('.slack-notification')?.textContent).toContain('Finish the requested change');
    const target = new URL(document.querySelector<HTMLAnchorElement>('.slack-notification .app-link')?.href ?? '', window.location.origin);
    expect(target.searchParams.get('run')).toBe('run-complete');
    click('[data-slack-read="voyage-completed-one"]');
    await vi.waitFor(() => expect(document.querySelector('[data-slack-read]')).toBeNull());
    await view.refresh();
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('0 unread');
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
  });

  it('immediately rescopes cached notifications, unread counts, and voyage links when the header changes', async () => {
    const first = state.notifications[0]!;
    state.notifications.push({ ...first, id: 'message-two', repo: 'org/other', prNumber: 88, runId: 'run-88', prUrl: 'https://github.com/org/other/pull/88' });
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    click('[data-slack-toggle]');
    expect(root.querySelectorAll('.slack-notification')).toHaveLength(2);
    expect(root.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    const slackRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith('/api/slack')).length;
    const before = slackRequests();
    for (const [repo, notification, runId] of [['org/other', 'message-two', 'run-88'], ['org/repo', 'message-one', 'run-42']] as const) {
      const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
      select.value = repo;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(root.querySelectorAll('.slack-notification')).toHaveLength(1);
      expect(root.querySelector('.slack-notification')?.getAttribute('data-notification-id')).toBe(notification);
      expect(root.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
      const target = new URL(root.querySelector('.slack-notification .app-link')?.getAttribute('href') ?? '', window.location.origin);
      expect(target.searchParams.get('repo')).toBe(repo);
      expect(target.searchParams.get('run')).toBe(runId);
      expect(root.querySelector<HTMLElement>('#slack-notifications')?.hidden).toBe(false);
      expect(slackRequests()).toBeGreaterThan(before);
    }
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelectorAll('.slack-notification')).toHaveLength(2);
    expect(root.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    for (const link of root.querySelectorAll<HTMLAnchorElement>('.slack-notification .app-link')) {
      expect(new URL(link.href).searchParams.has('repo')).toBe(false);
    }
    expect(slackRequests()).toBeGreaterThan(before);
  });

  it('persists reads across page refreshes and keeps the center accessible across views', async () => {
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    await view.start();
    click('[data-slack-toggle]');
    expect(document.querySelector<HTMLElement>('#slack-notifications')?.hidden).toBe(false);
    click('[data-slack-read]');
    await vi.waitFor(() => expect(document.querySelector('[data-slack-read]')).toBeNull());
    await view.refresh();
    expect(document.querySelector('.slack-notification')).not.toBeNull();
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('0 unread');
    click('[data-view="prs"]');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/prs'));
    expect(document.querySelector('[data-slack-toggle]')).not.toBeNull();
    click('[data-slack-toggle]');
    document.querySelector('[data-slack-toggle]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector<HTMLElement>('#slack-notifications')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-slack-toggle]'));
    view.destroy();
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    await view.start();
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('0 unread');
  });

  it('keeps unread notifications when persistence or polling fails', async () => {
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
    await view.start();
    click('[data-slack-toggle]');
    readFails = true;
    click('[data-slack-read]');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not mark'));
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toContain('1 unread');
    unavailable = true;
    await view.refresh();
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
    expect(document.querySelector('.slack-health')?.textContent).toContain('Automatic checks unavailable');
  });
});

describe('clear notification history', () => {
  it('dismisses read and unread notifications only in the header scope and persists the result after reopening', async () => {
    state.notifications.push({ ...state.notifications[0]!, id: 'other', repo: 'org/other', prUrl: 'https://github.com/org/other/pull/42' });
    state.notifications[0]!.readAt = state.notifications[0]!.createdAt;
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start();
    const select = document.querySelector<HTMLSelectElement>('.repo-select')!; select.value = 'org/repo'; select.dispatchEvent(new Event('change', { bubbles: true }));
    click('[data-slack-toggle]');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 0 unread');
    expect(document.querySelector<HTMLButtonElement>('[data-notifications-clear]')?.disabled).toBe(false);
    click('[data-notifications-clear]');
    await vi.waitFor(() => expect(document.querySelector('.slack-notification')).toBeNull());
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/notifications/clear')[0]?.[1]?.body).toBe(JSON.stringify({ repo: 'org/repo', clearToken: `1:${'a'.repeat(64)}` }));
    expect(state.notifications.map(item => item.id)).toEqual(['other']);
    view.destroy(); view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start(); click('[data-slack-toggle]');
    expect(document.querySelector('.slack-notification')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-notifications-clear]')?.disabled).toBe(true);
  });
  it('keeps history visible while clearing and blocks duplicate clicks', async () => {
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const clear = clearHandler; clearHandler = async input => { await waiting; return clear(input); };
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start(); click('[data-slack-toggle]');
    click('[data-notifications-clear]'); click('[data-notifications-clear]');
    expect(document.querySelector('.slack-notification')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-notifications-clear]')?.disabled).toBe(true);
    expect(document.querySelector('[data-notifications-clear]')?.textContent).toBe('Clearing…');
    expect(document.querySelector('#slack-notifications')?.getAttribute('aria-busy')).toBe('true');
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/notifications/clear')).toHaveLength(1);
    release(); await vi.waitFor(() => expect(document.querySelector('.slack-empty')).not.toBeNull());
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 0 unread');
  });
  it('retries the same captured cutoff after failure and keeps later arrivals', async () => {
    const requests: Array<{ repo: string | null; clearToken: string }> = [];
    clearHandler = async input => {
      requests.push(input);
      if (requests.length === 1) return new Response('', { status: 503 });
      state.notifications = state.notifications.filter(item => item.id !== 'message-one');
      return json({ ok: true, ...input, cleared: 1 });
    };
    view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start(); click('[data-slack-toggle]'); click('[data-notifications-clear]');
    await vi.waitFor(() => expect(document.querySelector('.slack-action-error')?.textContent).toContain('Could not clear'));
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
    expect(document.querySelector('[data-notifications-clear]')?.textContent).toBe('Retry clear');
    state.notifications.push({ ...state.notifications[0]!, id: 'later', createdAt: '2020-01-01T00:00:00Z' });
    state.clearToken = `2:${'b'.repeat(64)}`; await view.refresh(); click('[data-notifications-clear]');
    await vi.waitFor(() => expect(document.querySelector('[data-notifications-clear]')?.textContent).toBe('Clear all notifications'));
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
    expect(document.querySelector('.slack-notification')?.getAttribute('data-notification-id')).toBe('later');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
  });
});

it('loads scoped history when the selected galleon was absent from the globally capped snapshot', async () => {
  const quiet = { ...state.notifications[0]!, id: 'quiet' };
  const busy = { ...quiet, id: 'busy', repo: 'org/other', prUrl: 'https://github.com/org/other/pull/42' };
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname === '/api/slack' ? json({ ...state, notifications: url.searchParams.get('repo') === 'org/repo' ? [quiet] : [busy] }) : original(input, init);
  }));
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start(); click('[data-slack-toggle]');
  const select = document.querySelector<HTMLSelectElement>('.repo-select')!; select.value = 'org/repo'; select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[data-notification-id="quiet"]')).not.toBeNull());
  expect(document.querySelector<HTMLButtonElement>('[data-notifications-clear]')?.disabled).toBe(false);
  expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
});
