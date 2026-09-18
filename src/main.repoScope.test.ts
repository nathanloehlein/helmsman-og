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
    await vi.waitFor(() => expect(root.textContent).toContain(succeeds ? 'PROJB-1' : 'Helm unavailable for this repository'));
    expect(root.textContent).not.toContain('PROJA-1');
    expect(root.textContent).not.toContain('PROJA-2');
    expect(new URL(window.location.href).searchParams.get('repo')).toBe('org/b');
    expect(localStorage.getItem('runner.repoScope')).toBe('org/b');
  });
});
