import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { Ticket } from './types';

let view: DashboardView | undefined;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/triage?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => { view?.destroy(); view = undefined; vi.unstubAllGlobals(); localStorage.clear(); });

async function setup(assignmentFails = false) {
  const snapshot = await loadDashboard();
  const ticket: Ticket = { id: 'AB-123', title: 'Broken preview', description: 'Reproduce the issue', priority: 'P1', status: 'backlog', repo: 'org/a' };
  let assigned = false;
  const writes: { path: string; body: unknown }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    if (init?.method === 'POST') {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body ?? '{}')) });
      if (url.pathname.endsWith('/assign-self')) {
        if (assignmentFails) return json({ error: 'Jira assignment failed (403).' }, 502);
        assigned = true;
        return json({ ok: true });
      }
      if (url.pathname === '/api/agents/launch') return json({ runId: 'new-run' });
    }
    if (url.pathname === '/api/context') return json({ repos: ['org/a'], jiraBaseUrl: null, jiraEnabled: true });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: 'org/a' });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/triage') return json({ groups: { unassignedBacklog: assigned ? [] : [ticket], unassignedTodo: [], mineOpen: assigned ? [ticket] : [] }, degraded: false, jiraBaseUrl: null });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  return { root, writes };
}

describe('Triage ticket actions', () => {
  it('assigns without starting a run and preserves the expanded description after refreshing', async () => {
    const { root, writes } = await setup();
    root.querySelector<HTMLDetailsElement>('details[data-ticket-description]')!.open = true;
    root.querySelector<HTMLButtonElement>('[data-assign-ticket]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-assign-ticket]')).toBeNull());
    expect(writes).toEqual([{ path: '/api/tickets/AB-123/assign-self', body: {} }]);
    expect(root.querySelector<HTMLDetailsElement>('details[data-ticket-description]')?.open).toBe(true);
    expect(root.querySelector('[data-triage-column="mine"]')?.textContent).toContain('Broken preview');
    expect(root.querySelector<HTMLSelectElement>('.helm-head .repo-select')?.value).toBe('org/a');
  });
  it('shows assignment errors and allows retry', async () => {
    const { root } = await setup(true);
    root.querySelector<HTMLButtonElement>('[data-assign-ticket]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.ticket-action-status')?.textContent).toBe('Jira assignment failed (403).'));
    expect(root.querySelector<HTMLButtonElement>('[data-assign-ticket]')?.disabled).toBe(false);
  });
});
