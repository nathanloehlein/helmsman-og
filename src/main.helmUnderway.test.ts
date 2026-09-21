import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { renderDashboard } from './render';
import type { RunSummary } from './data/agents';
import type { OpenPr, Ticket } from './types';

let view: DashboardView | undefined;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/helm?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => { view?.destroy(); view = undefined; vi.unstubAllGlobals(); localStorage.clear(); });

const assigned: Ticket = { id: 'TASK-42', title: 'Existing work awaiting review', status: 'in-review', priority: 'P1', repo: 'a' };
const existingRun: RunSummary = { id: 'existing-run', ticketId: 'TASK-42', repo: 'org/a', status: 'succeeded', attempt: 1,
  prNumber: 42, startedAt: '2026-09-21T10:00:00Z', costUsd: null };
const associatedPr: OpenPr = { repo: 'org/a', number: 42, title: 'Existing work', draft: false,
  reviewDecision: 'REVIEW_REQUIRED', createdAt: '2026-09-21T11:00:00Z' };

async function setupUnderway(options: { ticket?: Ticket; runs?: RunSummary[]; prs?: OpenPr[]; degraded?: string[]; available?: boolean; repo?: string | null } = {}) {
  const repo = options.repo === undefined ? 'org/a' : options.repo;
  window.history.replaceState(null, '', repo ? `/helm?repo=${encodeURIComponent(repo)}` : '/helm');
  const snapshot = await loadDashboard();
  snapshot.underway = [options.ticket ?? assigned];
  snapshot.underwayAvailable = options.available ?? true;
  snapshot.myOpenPrs = options.prs ?? [associatedPr];
  const runs = options.runs ?? [existingRun];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reads: URL[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    if (init?.method && init.method !== 'GET') {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
      if (url.pathname === '/api/slack/review-request') return json({ ok: true, channel: 'airo-editing', mention: 'airo-editing-squad',
        permalink: 'https://godaddy.slack.com/archives/C123/p1789990000000000', sentAt: '2026-09-21T12:00:00Z' });
      return json({ error: 'Unexpected write' }, 500);
    }
    reads.push(url);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: options.degraded ?? [], repos: ['org/a', 'org/b'], selectedRepo: repo, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') return json({ runs, total: runs.length, limit: 25, offset: 0 });
    if (url.pathname.startsWith('/api/agents/')) {
      const matching = runs.find(run => run.id === url.pathname.split('/').at(-1));
      return json(matching ?? {}, matching ? 200 : 404);
    }
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/slack/review-requests') return json({ requests: [] });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr') return json({
      repo: url.searchParams.get('repo'), number: Number(url.searchParams.get('number')), state: 'open', isOwnPr: true,
      draft: false, merged: false, headRefName: 'task-42', reviewDecision: 'REVIEW_REQUIRED', comments: 0,
      checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/a/pull/42',
    });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  const panel = () => root.querySelector<HTMLElement>('[data-panel="underway"]')!;
  const row = () => panel().querySelector<HTMLElement>('.underway-row')!;
  return { root, view, writes, reads, panel, row };
}

describe('Helm underway tickets', () => {
  it('offers an explicit Slack request for inspection work without writing during render or refresh', async () => {
    const { panel, view, writes, reads } = await setupUnderway();
    await view.refresh();
    const button = panel().querySelector<HTMLButtonElement>('[data-slack-review-request]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.dataset.repo).toBe('org/a');
    expect(button?.dataset.number).toBe('42');
    expect(panel().querySelector('.launch-btn')).toBeNull();
    expect(writes).toEqual([]);
    const address = window.location.href;
    button!.click();
    await vi.waitFor(() => expect(panel().querySelector('.slack-review-result')?.textContent).toContain('Sent to #airo-editing'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/api/slack/review-request', body: { repo: 'org/a', prNumber: 42 } });
    expect(writes[0]?.body.requestId).toMatch(/^[a-f\d-]{36}$/i);
    expect(window.location.href).toBe(address);
    expect(reads.some(url => url.pathname === '/api/pr')).toBe(false);
  });

  it.each(['click', 'Enter'] as const)('opens the associated inspection PR by %s while preserving header scope', async activation => {
    const { row, writes, reads } = await setupUnderway();
    if (activation === 'click') row().querySelector<HTMLElement>('.queue-title')!.click();
    else {
      row().focus();
      row().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    await vi.waitFor(() => expect(window.location.pathname).toBe('/prs'));
    const query = new URLSearchParams(window.location.search);
    expect(query.get('repo')).toBe('org/a');
    expect(query.get('prRepo')).toBe('org/a');
    expect(query.get('pr')).toBe('42');
    expect(query.get('pane')).toBe('lookup');
    await vi.waitFor(() => expect(reads.some(url => url.pathname === '/api/pr' && url.searchParams.get('repo') === 'org/a')).toBe(true));
    expect(writes).toEqual([]);
  });

  it('opens the existing active voyage without launching a duplicate', async () => {
    const active = { ...existingRun, status: 'running', prNumber: null };
    const newer = { ...existingRun, id: 'newer-failed', status: 'failed', prNumber: null, startedAt: '2026-09-21T12:00:00Z' };
    const { root, row, panel, writes } = await setupUnderway({ ticket: { ...assigned, status: 'in-progress' }, runs: [newer, active], prs: [] });
    expect(panel().querySelector('.launch-btn')).toBeNull();
    row().querySelector<HTMLElement>('.queue-title')!.click();
    await vi.waitFor(() => expect(root.querySelector('.run-tab.is-active')?.getAttribute('data-tabid')).toBe('existing-run'));
    expect(window.location.pathname).toBe('/runs');
    const query = new URLSearchParams(window.location.search);
    expect(query.get('run')).toBe('existing-run');
    expect(query.get('repo')).toBe('org/a');
    expect(writes).toEqual([]);
  });

  it('offers multiple explicit PR links and leaves the row target unselected across galleons', async () => {
    const { row, panel, writes } = await setupUnderway({ repo: null, runs: [], prs: [
      { ...associatedPr, title: 'TASK-42 fix' }, { ...associatedPr, repo: 'org/b', number: 77, title: 'TASK-42 tests' },
    ] });
    const links = Array.from(panel().querySelectorAll<HTMLAnchorElement>('.underway-pr-action a'));
    expect(links.map(link => link.textContent)).toEqual(['org/a #42', 'org/b #77']);
    expect(links.map(link => new URL(link.href).searchParams.get('prRepo'))).toEqual(['org/a', 'org/b']);
    expect(panel().querySelectorAll('[data-slack-review-request]')).toHaveLength(2);
    const rowTarget = new URL(row().dataset.underwayHref!, window.location.origin);
    expect(rowTarget.searchParams.get('pr')).toBeNull();
    expect(rowTarget.searchParams.get('prRepo')).toBeNull();
    row().querySelector<HTMLElement>('.queue-title')!.click();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/prs'));
    expect(new URLSearchParams(window.location.search).get('pane')).toBe('authored');
    expect(new URLSearchParams(window.location.search).get('repo')).toBeNull();
    expect(writes).toEqual([]);
  });

  it.each(['missing', 'unavailable', 'draft'] as const)('disables Slack requests for %s inspection PRs without offering launch', async state => {
    const { panel, row, view, writes } = await setupUnderway({
      runs: state === 'missing' ? [] : [existingRun],
      prs: state === 'missing' ? [] : [{ ...associatedPr, draft: state === 'draft' }],
      degraded: state === 'unavailable' ? ['github'] : [],
    });
    await view.refresh();
    const button = panel().querySelector<HTMLButtonElement>('.slack-review-request');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(panel().querySelector('.launch-btn')).toBeNull();
    expect(new URL(row().dataset.underwayHref!, window.location.origin).pathname).toBe('/prs');
    button!.click();
    expect(writes).toEqual([]);
    expect(window.location.pathname).toBe('/helm');
  });

  it('opens an explicitly chosen PR without changing All galleons scope', async () => {
    const { panel, writes } = await setupUnderway({ repo: null, runs: [], prs: [
      { ...associatedPr, title: 'TASK-42 fix' }, { ...associatedPr, repo: 'org/b', number: 77, title: 'TASK-42 tests' },
    ] });
    const links = panel().querySelectorAll<HTMLAnchorElement>('.underway-pr-action a');
    links[1]!.click();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/prs'));
    const query = new URLSearchParams(window.location.search);
    expect(query.get('repo')).toBeNull();
    expect(query.get('prRepo')).toBe('org/b');
    expect(query.get('pr')).toBe('77');
    expect(query.get('pane')).toBe('lookup');
    expect(writes).toEqual([]);
  });

  it('renders no ticket navigation or send controls when underway data is unavailable', async () => {
    const { panel, writes } = await setupUnderway({ available: false, degraded: ['jira-underway'] });
    expect(panel().textContent).toContain('Underway tickets unavailable');
    expect(panel().querySelector('.underway-row, .launch-btn, .slack-review-request')).toBeNull();
    expect(writes).toEqual([]);
  });

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
      if (url.pathname === '/api/slack/review-requests') return json({ requests: [] });
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
    expect(panel?.textContent).toContain('Select a galleon');
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
