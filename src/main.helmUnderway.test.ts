import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { renderDashboard } from './render';

let view: DashboardView | undefined;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/helm?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => { view?.destroy(); view = undefined; vi.unstubAllGlobals(); localStorage.clear(); });

describe('Helm underway tickets', () => {
  it('launches a selected unfinished ticket using the full selected repository', async () => {
    const snapshot = await loadDashboard();
    snapshot.underway = [{ id: 'TASK-42', title: 'Existing in-progress work', status: 'in-progress', priority: 'P1', repo: 'a' }];
    snapshot.underwayAvailable = true;
    const launches: unknown[] = [];
    const json = (data: unknown) => new Response(JSON.stringify(data));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/context') return json({ repos: ['org/a'], jiraBaseUrl: null });
      if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: 'org/a', jiraBaseUrl: null });
      if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1 } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
      if (url.pathname === '/api/agents/launch') { launches.push(JSON.parse(String(init?.body))); return json({ runId: 'new-run' }); }
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    const panel = root.querySelector('[data-panel="underway"]');
    expect(panel?.textContent).toContain('Mine · underway');
    expect(panel?.textContent).toContain('In Progress');
    const launch = panel?.querySelector<HTMLButtonElement>('.launch-btn');
    expect(launch?.dataset.repo).toBe('org/a');
    launch?.click();
    await vi.waitFor(() => expect(launches).toEqual([{ ticketId: 'TASK-42', title: 'Existing in-progress work', repo: 'org/a', mode: 'ticket' }]));
    await vi.waitFor(() => expect(root.querySelector('.run-tab.is-active')?.textContent).toContain('TASK-42'));
  });

  it('keeps ticket status separate from running agents and requires a scoped repository to launch', async () => {
    const snapshot = await loadDashboard();
    snapshot.underwayAvailable = true;
    snapshot.underway = [{ id: 'TASK-42', title: 'Assigned work', status: 'in-progress', priority: 'P0', repo: 'a' }, { id: 'TASK-99', title: 'Done work', status: 'done', priority: 'P1', repo: 'a' }];
    const root = document.querySelector<HTMLElement>('#app')!;
    renderDashboard(root, snapshot, new Date());
    const panel = root.querySelector('[data-panel="underway"]');
    expect(panel?.querySelector('.faceplate-count')?.textContent).toBe('1');
    expect(panel?.textContent).toContain('TASK-42');
    expect(panel?.textContent).not.toContain('TASK-99');
    expect(panel?.querySelector('.launch-btn')).toBeNull();
    expect(panel?.textContent).toContain('Select a repository');
    expect(root.querySelector('[data-panel="running"] .agent-row')).toBeNull();
  });

  it('never offers launch controls for unavailable or sample underway data', async () => {
    const snapshot = await loadDashboard();
    snapshot.underwayAvailable = false;
    snapshot.underway = [{ id: 'TASK-42', title: 'Stale work', status: 'in-progress', priority: 'P1', repo: 'a' }];
    const root = document.querySelector<HTMLElement>('#app')!;
    renderDashboard(root, snapshot, new Date(), ['jira-underway'], ['org/a'], 'org/a');
    const panel = root.querySelector('[data-panel="underway"]');
    expect(panel?.textContent).toContain('Underway tickets unavailable');
    expect(panel?.querySelector('.launch-btn')).toBeNull();
    expect(root.querySelector('.degraded-banner')).toBeNull();
  });
});
