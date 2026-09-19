import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { SlackState } from './data/slack';

const json = (data: unknown): Response => new Response(JSON.stringify(data));
let view: DashboardView | undefined;
let state: SlackState;
let unavailable: boolean;
let readFails: boolean;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/helm');
  unavailable = false;
  readFails = false;
  state = {
    health: { enabled: true, status: 'healthy', channelName: 'airo-editing', intervalMs: 300_000, lastSuccessAt: null, error: null },
    notifications: [{ id: 'message-one', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42', sourceUrl: 'https://company.slack.com/archives/C123/p123456789', author: 'Alex', channelName: 'airo-editing', status: 'launched', runId: 'run-42', createdAt: '2026-09-17T12:00:00Z', updatedAt: '2026-09-17T12:00:00Z', readAt: null, error: null }],
  };
  const snapshot = await loadDashboard();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/slack') return unavailable ? new Response('', { status: 503 }) : json(state);
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
    const slackRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/slack').length;
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
      expect(slackRequests()).toBe(before);
    }
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelectorAll('.slack-notification')).toHaveLength(2);
    expect(root.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    for (const link of root.querySelectorAll<HTMLAnchorElement>('.slack-notification .app-link')) {
      expect(new URL(link.href).searchParams.has('repo')).toBe(false);
    }
    expect(slackRequests()).toBe(before);
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
    expect(document.querySelector('.slack-health')?.textContent).toContain('Reader unavailable');
  });
});
