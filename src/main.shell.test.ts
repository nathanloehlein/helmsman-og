import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { LOCAL_POLL_MS } from './data/live';
import type { RunSummary } from './data/agents';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | null = null;

async function setup(path = '/helm?repo=org/a', degraded: string[] = []) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadDashboard();
  const runs: RunSummary[] = [{ id: 'run-a', ticketId: 'TASK-1', repo: 'org/a', status: 'running', attempt: 1, prNumber: null, startedAt: new Date().toISOString(), costUsd: null }];
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded, repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: 'airo-editing', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/repo/local') return json({ repo: url.searchParams.get('repo'), path: '/repo', branches: [], worktrees: [], error: null });
    if (url.pathname === '/api/triage') return json({ groups: { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] }, degraded: false, selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/bugs') return json({ cards: [], degraded: false, generatedAt: '', latestWindow: '', previousWindow: '' });
    if (url.pathname === '/api/cmux/tabs') return json({ connected: false, tabs: [] });
    return new Response(null, { status: 404 });
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  await vi.advanceTimersByTimeAsync(0);
  const count = (endpoint: string) => requests.filter(item => item === endpoint).length;
  const switchTo = async (page: string) => {
    root.querySelector<HTMLAnchorElement>(`[data-view="${page}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { root, runs, count, switchTo };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-17T21:00:00Z');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('persistent app shell', () => {
  it('keeps the same header, tabs, counts, footer, and notification controls across all seven views', async () => {
    const { root, switchTo } = await setup();
    const selectors = ['.helm-head', '.nameplate', '.repo-select', '.helm-readout', '.page-tabs', '.app-footer', '.operator-note', '[data-slack-toggle]', '.slack-popover', '#page-content'];
    const elements = selectors.map(selector => root.querySelector(selector));
    const counts = root.querySelector('.helm-readout')?.textContent;
    const footer = root.querySelector('.app-footer')?.textContent;
    for (const page of ['prs', 'runs', 'triage', 'bugs', 'config', 'cmux', 'dashboard']) {
      await switchTo(page);
      selectors.forEach((selector, i) => expect(root.querySelector(selector), `${page}: ${selector}`).toBe(elements[i]));
      expect(root.querySelector('.helm')?.getAttribute('data-page')).toBe(page);
      expect(root.querySelector('#page-content')?.getAttribute('aria-labelledby')).toBe(`page-tab-${page}`);
      expect(root.querySelectorAll('.page-tab[aria-selected="true"]')).toHaveLength(1);
      expect(root.querySelector('.helm-readout')?.textContent).toBe(counts);
      expect(root.querySelector('.app-footer')?.textContent).toBe(footer);
      expect(root.querySelector('#page-content .app-footer')).toBeNull();
      expect(root.querySelector('#page-content .helm-head')).toBeNull();
    }
  });

  it('shows unknown queue/review on direct Config without fetching external data for counts', async () => {
    const { root, count } = await setup('/config?repo=org/a');
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('1');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-footer-running]')?.textContent).toBe('1 underway');
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/open')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    expect(count('/api/triage')).toBe(0);
    expect(count('/api/bugs')).toBe(0);
  });

  it.each(['jira', 'github'])('uses Jira availability for queue and review when %s is unavailable', async service => {
    const { root } = await setup('/helm?repo=org/a', [service]);
    const queue = root.querySelector('[data-fleet-count="queued"]')?.textContent;
    const review = root.querySelector('[data-fleet-count="review"]')?.textContent;
    if (service === 'jira') {
      expect(queue).toBe('—');
      expect(review).toBe('—');
    } else {
      expect(queue).toBe('7');
      expect(review).toBe('2');
    }
  });

  it('updates shared underway counts on Config without replacing its draft or shared controls', async () => {
    const { root, runs, switchTo, count } = await setup();
    await switchTo('config');
    const input = root.querySelector<HTMLInputElement>('input.config-input')!;
    input.value = 'Unsaved draft';
    const header = root.querySelector('.helm-head');
    const footer = root.querySelector('.app-footer');
    const queue = root.querySelector('[data-fleet-count="queued"]')?.textContent;
    runs[0]!.status = 'succeeded';
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(root.querySelector('input.config-input')).toBe(input);
    expect(input.value).toBe('Unsaved draft');
    expect(root.querySelector('.helm-head')).toBe(header);
    expect(root.querySelector('.app-footer')).toBe(footer);
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('0');
    expect(root.querySelector('[data-footer-running]')?.textContent).toBe('0 underway');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe(queue);
    expect(count('/api/dashboard')).toBe(1);
  });

  it('registers one repository change handler after repeated navigation and clears counts for an unloaded scope', async () => {
    const { root, switchTo, count } = await setup();
    await switchTo('runs');
    await switchTo('config');
    await switchTo('runs');
    await switchTo('config');
    const before = count('/api/config');
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.repo-select')).toBe(repo);
    expect(count('/api/config')).toBe(before + 1);
    expect(count('/api/dashboard')).toBe(1);
    expect(root.querySelector('[data-fleet-count="running"]')?.textContent).toBe('0');
    expect(root.querySelector('[data-fleet-count="queued"]')?.textContent).toBe('—');
    expect(root.querySelector('[data-fleet-count="review"]')?.textContent).toBe('—');
  });

  it('removes delegated controls when the app is recreated in the same root', async () => {
    const { root, count } = await setup('/config?repo=org/a');
    view!.destroy();
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = count('/api/config');
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/config')).toBe(before + 1);
    root.querySelector<HTMLButtonElement>('[data-slack-toggle]')!.click();
    expect(root.querySelector<HTMLElement>('.slack-popover')?.hidden).toBe(false);
  });

  it('preserves notification popup identity and scroll during navigation and keyboard tab focus during refresh', async () => {
    const { root } = await setup();
    const bell = root.querySelector<HTMLButtonElement>('[data-slack-toggle]')!;
    bell.click();
    const popover = root.querySelector<HTMLElement>('.slack-popover')!;
    popover.scrollTop = 40;
    window.history.pushState(null, '', '/runs?repo=org/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('[data-slack-toggle]')).toBe(bell);
    expect(root.querySelector('.slack-popover')).toBe(popover);
    expect(popover.hidden).toBe(false);
    expect(popover.scrollTop).toBe(40);
    expect(document.activeElement).toBe(bell);
    const runs = root.querySelector<HTMLAnchorElement>('[data-view="runs"]')!;
    runs.focus();
    runs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const focused = document.activeElement;
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(document.activeElement).toBe(focused);
    expect(root.querySelectorAll('.page-tab[tabindex="0"]')).toHaveLength(1);
  });
});

describe('Helm panel keyboard controls', () => {
  it('moves panels with arrow keys, persists the layout, and retains keyboard focus', async () => {
    const { root } = await setup();
    const handle = root.querySelector<HTMLButtonElement>('.rack-handle[data-panel="underway"]')!;
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    let layout = JSON.parse(localStorage.getItem('helmsman.rackLayout') ?? '[]');
    expect(layout[0][1].active).toBe('underway');
    expect(document.activeElement).toBe(root.querySelector('.rack-handle[data-panel="underway"]'));
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    layout = JSON.parse(localStorage.getItem('helmsman.rackLayout') ?? '[]');
    expect(layout[1].at(-1).active).toBe('underway');
    expect(document.activeElement).toBe(root.querySelector('.rack-handle[data-panel="underway"]'));
    view!.destroy();
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelectorAll('.rack-column')[1]?.querySelector('.rack-handle[data-panel="underway"]')).not.toBeNull();
  });

  it('navigates stacked panels by keyboard and retains focus after selection and collapse', async () => {
    localStorage.setItem('helmsman.rackLayout', JSON.stringify([[{ panels: ['newrun', 'backlog'], active: 'newrun', collapsed: false }]]));
    const { root } = await setup();
    const tab = root.querySelector<HTMLButtonElement>('.slot-tab[data-panel-tab="newrun"]')!;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const selected = root.querySelector<HTMLButtonElement>('.slot-tab[data-panel-tab="backlog"]')!;
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.tabIndex).toBe(0);
    expect(document.activeElement).toBe(selected);
    expect(window.location.search).toContain('pane=backlog');
    selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector('.slot-tab[data-panel-tab="newrun"]'));
    root.querySelector<HTMLButtonElement>('.panel-collapse[data-panel="newrun"]')!.click();
    expect(document.activeElement).toBe(root.querySelector('.panel-collapse[data-panel="newrun"]'));
  });
});
