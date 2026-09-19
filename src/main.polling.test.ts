import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import { LOCAL_POLL_MS, POLL_MS } from './data/live';
import type { RunSummary } from './data/agents';

const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let view: DashboardView | null = null;

async function setup(path = '/helm?repo=org/a', runs: RunSummary[] = [], contextAvailable = true, jiraEnabled = true) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadMockSnapshot();
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname === '/api/context') return contextAvailable ? json({ repos: ['org/a'], jiraBaseUrl: null, jiraEnabled }) : new Response(null, { status: 404 });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null, jiraEnabled });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  return { root, requests, fetcher, count: (path: string) => requests.filter(item => item === path).length };
}

function visible(value: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(!value);
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('view-aware polling', () => {
  it('refreshes local status every 30 seconds and GitHub data only every five minutes', async () => {
    const { count } = await setup();
    expect(count('/api/dashboard')).toBe(1);
    expect(count('/api/pr/open')).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - LOCAL_POLL_MS);
    expect(count('/api/dashboard')).toBe(1);
    expect(count('/api/pr/open')).toBe(1);
    expect(count('/api/agents')).toBe(10);
    expect(count('/api/config')).toBe(1);
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(count('/api/dashboard')).toBe(2);
    expect(count('/api/pr/open')).toBe(2);
  });

  it('updates local run status without refetching GitHub or discarding the task draft', async () => {
    const runs: RunSummary[] = [{ id: 'run-1', ticketId: 'TEST-1', repo: 'org/a', status: 'running',
      attempt: 1, prNumber: null, startedAt: new Date().toISOString(), costUsd: null }];
    const { root, count } = await setup('/helm?repo=org/a', runs);
    const task = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    task.value = 'Preserve this draft';
    expect(root.querySelector('[data-panel="running"] [data-runid="run-1"]')).not.toBeNull();
    runs[0]!.status = 'succeeded';
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(root.querySelector('[data-panel="running"] [data-runid="run-1"]')).toBeNull();
    expect(root.querySelector('[data-panel="recent"] [data-runid="run-1"]')).not.toBeNull();
    expect(root.querySelector('.helm-readout .seg7')?.textContent).toBe('0');
    expect(root.querySelector('.newrun-task')).toBe(task);
    expect(task.value).toBe('Preserve this draft');
    expect(count('/api/dashboard')).toBe(1);
  });

  it.each([true, false])('keeps the new-run draft and caret during full dashboard refresh (Jira %s)', async jiraEnabled => {
    const { root, count } = await setup('/helm?repo=org/a', [], true, jiraEnabled);
    const task = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    task.value = 'Keep these task instructions';
    task.focus();
    task.setSelectionRange(5, 10);
    const freeform = root.querySelector<HTMLInputElement>('.newrun-mode[value="freeform"]')!;
    freeform.checked = true;
    const model = root.querySelector<HTMLSelectElement>('.newrun-model')!;
    const modelChoice = model.options[1]?.value ?? '';
    model.value = modelChoice;
    await vi.advanceTimersByTimeAsync(jiraEnabled ? POLL_MS : LOCAL_POLL_MS);
    const updated = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    expect(count('/api/dashboard')).toBe(2);
    expect(updated.value).toBe('Keep these task instructions');
    expect(document.activeElement).toBe(updated);
    expect([updated.selectionStart, updated.selectionEnd]).toEqual([5, 10]);
    expect(root.querySelector<HTMLInputElement>('.newrun-mode[value="freeform"]')?.checked).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('.newrun-model')?.value).toBe(modelChoice);
  });

  it('stops hidden polling and refreshes only overdue data upon return', async () => {
    const { count } = await setup();
    visible(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(1);
    expect(count('/api/agents')).toBe(1);
    visible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(2);
    expect(count('/api/agents')).toBe(2);
    visible(false);
    visible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(2);
    expect(count('/api/agents')).toBe(2);
  });

  it.each(['/config', '/runs', '/cmux'])('does not refresh external data while on %s', async (path) => {
    const { count } = await setup(path);
    expect(count('/api/context')).toBe(2);
    expect(count('/api/dashboard')).toBe(0);
    const initialConfig = count('/api/config');
    const initialGit = count('/api/repo/local');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(0);
    expect(count('/api/pr/open')).toBe(0);
    expect(count('/api/pr/review-requests')).toBe(0);
    expect(count('/api/config')).toBe(initialConfig);
    expect(count('/api/repo/local')).toBe(initialGit);
    expect(count('/api/agents')).toBeGreaterThan(1);
    expect(count('/api/context')).toBeGreaterThan(2);
  });

  it('loads the dashboard when leaving a metadata-only Config bootstrap', async () => {
    const { root, count } = await setup('/config?repo=org/a');
    expect(count('/api/dashboard')).toBe(0);
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    root.querySelector<HTMLAnchorElement>('[data-view="dashboard"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(1);
    expect(count('/api/pr/open')).toBe(1);
    expect(root.querySelector('[data-page="dashboard"]')).not.toBeNull();
  });

  it('fetches the dashboard after navigating during a local Config refresh', async () => {
    const { root, count, fetcher } = await setup('/config?repo=org/a');
    const original = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation(async input => String(input).startsWith('/api/agents') ? pending : original(input));
    const refresh = view!.refresh();
    root.querySelector<HTMLAnchorElement>('[data-view="dashboard"]')!.click();
    resolve(json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }));
    await refresh;
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/dashboard')).toBe(1);
    expect(root.querySelector('[data-page="dashboard"]')).not.toBeNull();
  });

  it('falls back to the existing dashboard bootstrap if context is unavailable', async () => {
    const { root, count } = await setup('/runs?repo=org/a', [], false);
    expect(count('/api/context')).toBe(2);
    expect(count('/api/dashboard')).toBe(1);
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/dashboard')).toBe(1);
  });

  it('loads relevant lists on navigation without refetching fresh dashboard data', async () => {
    const { root, count } = await setup('/config');
    root.querySelector<HTMLAnchorElement>('[data-view="prs"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/pr/review-requests')).toBe(1);
    expect(count('/api/dashboard')).toBe(1);
    root.querySelector<HTMLAnchorElement>('[data-view="config"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLAnchorElement>('[data-view="prs"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/api/pr/review-requests')).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(count('/api/pr/review-requests')).toBe(2);
    expect(count('/api/dashboard')).toBe(2);
  });

  it('loads the destination view when navigation shares a pending list refresh', async () => {
    const { root, fetcher, count } = await setup();
    const original = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation(async input => String(input).startsWith('/api/pr/open') ? pending : original(input));
    const refresh = view!.refresh();
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLAnchorElement>('[data-view="prs"]')!.click();
    resolve(json({ prs: [], degraded: false, truncated: false }));
    await refresh;
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('[data-page="prs"]')).not.toBeNull();
    expect(count('/api/pr/review-requests')).toBe(1);
  });

  it('shares in-flight refreshes and disposes the recurring timer', async () => {
    const { count, fetcher } = await setup();
    const original = fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    fetcher.mockImplementation(async input => String(input).startsWith('/api/dashboard') ? pending : original(input));
    const first = view!.refresh();
    const second = view!.refresh();
    expect(second).toBe(first);
    resolve(new Response(null, { status: 503 }));
    await first;
    view!.destroy();
    const before = count('/api/agents');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(count('/api/agents')).toBe(before);
  });
});
