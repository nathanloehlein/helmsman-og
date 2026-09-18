import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';

let view: DashboardView | undefined;
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Helm repository scope changes', () => {
  it.each(['triage', 'bugs'] as const)('clears previous %s rows on scope change and ignores a late response from that scope', async page => {
    window.history.replaceState(null, '', `/${page}?repo=org/a`);
    let resolveOld!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { resolveOld = resolve; });
    const responseB = new Promise<Response>(resolve => { resolveB = resolve; });
    const requests: string[] = [];
    let aRequests = 0;
    const payload = (repo: string, key: string) => page === 'triage'
      ? { groups: { unassignedBacklog: [{ id: key, title: key, repo, priority: 'P1', status: 'backlog' }], unassignedTodo: [], mineOpen: [] }, degraded: false, selectedRepo: repo, jiraBaseUrl: null }
      : { cards: [{ project: key, repo, label: key, open: 1, delta: 0, completed: 0, pastSla: 0, oldest: null, p75: { days: null, n: 0, capped: false }, rows: [{ key, title: key, priority: 'P1', severity: 'S2', sla: { text: 'No SLA', overdue: false, days: null } }], degraded: false, jiraBaseUrl: null }], degraded: false, generatedAt: '', latestWindow: '', previousWindow: '' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true });
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === `/api/${page}`) {
        const repo = url.searchParams.get('repo') ?? '';
        requests.push(repo);
        if (repo === 'org/b') return responseB;
        if (++aRequests > 1) return oldResponse;
        return json(payload(repo, 'PROJA-1'));
      }
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    expect(root.textContent).toContain('PROJA-1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(aRequests).toBe(2));

    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.textContent).not.toContain('PROJA-1');
    await vi.waitFor(() => expect(requests).toContain('org/b'));
    resolveB(json(payload('org/b', 'PROJB-1')));
    await vi.waitFor(() => expect(root.textContent).toContain('PROJB-1'));
    resolveOld(json(payload('org/a', 'PROJA-99')));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.textContent).toContain('PROJB-1');
    expect(root.textContent).not.toContain('PROJA-99');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
  });

  it('reloads Helm immediately after visiting another repository on a page that does not fetch dashboards', async () => {
    const snapshot = await loadDashboard();
    snapshot.queue = [{ id: 'PROJA-1', title: 'A requirements', repo: 'org/a', priority: 'P1', status: 'backlog' }];
    const dashboardRequests: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
      if (url.pathname === '/api/dashboard') {
        const repo = url.searchParams.get('repo');
        dashboardRequests.push(repo);
        return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: repo, jiraBaseUrl: null });
      }
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    expect(root.textContent).toContain('PROJA-1');
    expect(dashboardRequests).toEqual(['org/a']);

    window.history.pushState(null, '', '/runs?repo=org/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(root.querySelector('.helm')?.getAttribute('data-page')).toBe('runs'));
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    expect(dashboardRequests).toEqual(['org/a']);

    window.history.pushState(null, '', '/?repo=org/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(dashboardRequests).toEqual(['org/a', 'org/a']));
    await vi.waitFor(() => expect(root.textContent).toContain('PROJA-1'));
    expect(root.textContent).not.toContain('Loading Helm');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
  });

  it.each([true, false])('removes old repository data during a pending scope fetch and after success=%s', async succeeds => {
    const snapshot = await loadDashboard();
    snapshot.queue = [{ id: 'PROJA-1', title: 'A requirements', repo: 'org/a', priority: 'P1', status: 'backlog' }];
    snapshot.underway = [{ id: 'PROJA-2', title: 'A underway', repo: 'org/a', priority: 'P1', status: 'in-progress' }];
    snapshot.underwayAvailable = true;
    snapshot.shipped = [];
    snapshot.activity = [];
    snapshot.stats = { completedToday: 0, awaitingReview: 1, avgCycleMinutes: 0 };
    let resolveB!: (response: Response) => void;
    const pendingB = new Promise<Response>(resolve => { resolveB = resolve; });
    const requested: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
      if (url.pathname === '/api/dashboard') {
        const repo = url.searchParams.get('repo');
        requested.push(repo);
        if (repo === 'org/b') return pendingB;
        return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: repo, jiraBaseUrl: null });
      }
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    expect(root.textContent).toContain('PROJA-1');
    expect(root.textContent).toContain('PROJA-2');
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requested).toContain('org/b'));
    expect(root.textContent).not.toContain('PROJA-1');
    expect(root.textContent).not.toContain('PROJA-2');
    expect(root.textContent).toContain('Loading Helm');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/b');
    resolveB(succeeds ? json({ snapshot: {
      ...snapshot,
      queue: [{ id: 'PROJB-1', title: 'B requirements', repo: 'org/b', priority: 'P1', status: 'backlog' }],
      underway: [],
    }, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: 'org/b', jiraBaseUrl: null }) : new Response(null, { status: 503 }));
    await vi.waitFor(() => expect(root.textContent).toContain(succeeds ? 'PROJB-1' : 'Helm unavailable for this galleon'));
    expect(root.textContent).not.toContain('PROJA-1');
    expect(root.textContent).not.toContain('PROJA-2');
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/b');
    expect(localStorage.getItem('runner.repoScope')).toBe('org/b');
  });
});
