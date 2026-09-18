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
    if (url.pathname === '/api/slack/notifications/message-one/read') {
      expect(init?.method).toBe('POST');
      if (readFails) return new Response('', { status: 500 });
      state = { ...state, notifications: state.notifications.map(item => ({ ...item, readAt: new Date().toISOString() })) };
      return json({ ok: true });
    }
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo'], selectedRepo: null, jiraBaseUrl: null });
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
