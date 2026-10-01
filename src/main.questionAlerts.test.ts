import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { Clarification } from './data/clarifications';

let view: DashboardView | undefined;
let questions: Clarification[];
const question = (id: string, repo = 'org/repo'): Clarification => ({ id, repo, runId: 'run', question: 'Which approach?', required: true,
  owner: 'local', contactId: null, state: 'pending', answer: null, createdAt: '2026-10-01T00:00:00Z', timeoutAt: null, answeredAt: null });
const json = (data: unknown) => new Response(JSON.stringify(data));
beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); window.history.replaceState(null, '', '/helm');
  questions = [question('one'), question('two', 'org/other')];
  const snapshot = await loadDashboard();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/clarifications') return json({ clarifications: questions });
    if (url.pathname === '/api/trusted-contacts') return json({ contacts: [] });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo', 'org/other'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/slack') return json({ notifications: [], health: { enabled: false, status: 'disabled' } });
    return json({});
  }));
});
afterEach(() => { view?.destroy(); view = undefined; vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear(); });
it('keeps the live question badge in the shell, follows header scope, and clears on navigation', async () => {
  const audio = vi.fn(); vi.stubGlobal('AudioContext', audio);
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!); await view.start();
  const tab = () => document.querySelector<HTMLElement>('#page-tab-clarifications');
  await vi.waitFor(() => expect(tab()?.getAttribute('aria-label')).toBe('Agent Questions, 2 unanswered questions'));
  expect(tab()?.classList.contains('has-pending-questions')).toBe(true);
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  expect(audio).not.toHaveBeenCalled();
  const select = document.querySelector<HTMLSelectElement>('.repo-select')!; select.value = 'org/repo'; select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(tab()?.classList.contains('has-pending-questions')).toBe(false);
  await vi.waitFor(() => expect(tab()?.getAttribute('aria-label')).toBe('Agent Questions, 1 unanswered question'));
  tab()?.click();
  expect(tab()?.classList.contains('has-pending-questions')).toBe(false);
  await vi.waitFor(() => expect(window.location.pathname).toBe('/clarifications'));
  document.querySelector<HTMLElement>('[data-view="dashboard"]')?.click();
  await vi.waitFor(() => expect(tab()?.classList.contains('has-pending-questions')).toBe(true));
  questions = []; document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(tab()?.querySelector('.question-alert-count')).toBeNull());
});
