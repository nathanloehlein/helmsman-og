import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { RunSummary } from './data/agents';

const FAILED = '550e8400-e29b-41d4-a716-446655440001';
const SUCCEEDED = '550e8400-e29b-41d4-a716-446655440002';
const RUNNING = '550e8400-e29b-41d4-a716-446655440003';
const STOPPED = '550e8400-e29b-41d4-a716-446655440004';
const FRESH = '550e8400-e29b-41d4-a716-446655440005';
const views: DashboardView[] = [];
const streams: RunStream[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

class RunStream {
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();
  constructor(url: string) { this.url = url; streams.push(this); }
  emit(kind: string, text: string, id: number): void {
    this.onmessage?.({ data: JSON.stringify({ id, runId: this.url.split('/').at(-2), ts: '2026-09-18T00:00:00Z', kind, text }) } as MessageEvent<string>);
  }
}

function run(id: string, status: string): RunSummary {
  return { id, ticketId: 'TODO-1', repo: 'org/repo', status, attempt: 1, prNumber: null, startedAt: '2026-09-18T00:00:00Z', costUsd: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(path: string, retry: () => Promise<Response> = async () => json({ runId: FRESH })) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadDashboard();
  const runs = [run(FAILED, 'failed'), run(SUCCEEDED, 'succeeded'), run(RUNNING, 'running'), run(STOPPED, 'stopped')];
  const requests: { pathname: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    requests.push({ pathname: url.pathname, method });
    if (method === 'POST' && url.pathname === `/api/agents/${FAILED}/retry`) {
      const response = await retry();
      if (response.ok) runs.unshift(run(FRESH, 'running'));
      return response;
    }
    if (method !== 'GET') throw new Error(`Unexpected write: ${method} ${url.pathname}`);
    if (url.pathname === '/api/context') return json({ repos: ['org/repo'], jiraBaseUrl: null, jiraEnabled: true });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo'], selectedRepo: null, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname.startsWith('/api/agents/')) {
      const detail = runs.find(item => item.id === url.pathname.split('/').at(-1));
      return detail ? json(detail) : json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    return json({});
  }));
  const view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
  views.push(view);
  await view.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  vi.useFakeTimers();
  return { requests, runs };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  streams.length = 0;
  vi.stubGlobal('EventSource', RunStream);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const buttons = (id = FAILED) => Array.from(document.querySelectorAll<HTMLButtonElement>(`.voyage-retry[data-retry-run-id="${id}"]`));
const feedback = () => Array.from(document.querySelectorAll<HTMLElement>(`.voyage-retry-feedback[data-retry-feedback-for="${FAILED}"][role="status"]`));
const flush = () => vi.advanceTimersByTimeAsync(40);
const writes = (requests: { method: string }[]) => requests.filter(request => request.method !== 'GET');

describe('retrying a failed voyage', () => {
  it('adds retry after a live failure without replacing the drawer log or its existing output', async () => {
    const { runs } = await setup(`/runs?run=${RUNNING}`);
    const stream = streams.find(item => item.url === `/api/agents/${RUNNING}/log`)!;
    expect(buttons(RUNNING)).toHaveLength(0);
    stream.emit('log', 'Keep this output', 1);
    await flush();
    const log = document.querySelector('.run-drawer-body');
    const firstLine = log?.firstElementChild;
    const current = runs.find(item => item.id === RUNNING)!;
    current.status = 'failed';
    stream.emit('run-complete', 'failed', 2);
    await flush();
    expect(document.querySelector('.run-drawer-body')).toBe(log);
    expect(log?.firstElementChild).toBe(firstLine);
    expect(firstLine?.textContent).toBe('Keep this output');
    expect(document.querySelector(`.run-drawer-retry .voyage-retry[data-retry-run-id="${RUNNING}"]`)).not.toBeNull();
  });

  it.each(['/', `/runs?run=${FAILED}`])('exposes retry only for failed voyages on %s', async (path) => {
    await setup(path);
    expect(buttons().length).toBeGreaterThan(0);
    for (const id of [SUCCEEDED, RUNNING, STOPPED]) expect(buttons(id)).toHaveLength(0);
    expect(buttons().every(button => button.tagName === 'BUTTON' && button.type === 'button')).toBe(true);
  });

  it('posts the complete source UUID and opens only the fresh voyage when retry succeeds', async () => {
    const pending = deferred<Response>();
    const { requests } = await setup('/runs', () => pending.promise);
    buttons()[0]!.click();
    await flush();
    expect(writes(requests)).toEqual([{ pathname: `/api/agents/${FAILED}/retry`, method: 'POST' }]);
    expect(new URL(window.location.href).searchParams.get('run')).toBeNull();
    expect(document.querySelector('.run-tab')).toBeNull();
    pending.resolve(json({ runId: FRESH }));
    await flush();
    expect(new URL(window.location.href).searchParams.get('run')).toBe(FRESH);
    expect(document.querySelector(`.run-tab.is-active[data-tabid="${FRESH}"]`)).not.toBeNull();
    expect(document.querySelector(`.run-tab[data-tabid="${FAILED}"]`)).toBeNull();
    expect(streams.some(stream => stream.url === `/api/agents/${FRESH}/log`)).toBe(true);
  });

  it('disables every control for the same source and suppresses duplicate clicks while pending', async () => {
    const pending = deferred<Response>();
    const { requests } = await setup(`/runs?run=${FAILED}`, () => pending.promise);
    const controls = buttons();
    expect(controls.length).toBeGreaterThanOrEqual(2);
    controls[0]!.click();
    controls[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    controls[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(writes(requests)).toHaveLength(1);
    for (const button of buttons()) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.textContent).toContain('Retrying');
    }
    expect(new URL(window.location.href).searchParams.get('run')).toBe(FAILED);
    pending.resolve(json({ error: 'Repository already has an active voyage.' }, 409));
    await flush();
  });

  it.each(['server', 'network'])('shows a recoverable inline error and reenables controls after %s failure', async (failure) => {
    const retry = failure === 'server'
      ? async () => json({ error: 'Original task is unavailable.' }, 409)
      : async (): Promise<Response> => { throw new Error('Network unavailable'); };
    await setup(`/runs?run=${FAILED}`, retry);
    const address = window.location.href;
    buttons()[0]!.click();
    await flush();
    expect(window.location.href).toBe(address);
    for (const button of buttons()) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-busy')).not.toBe('true');
      expect(button.textContent).not.toContain('Retrying');
    }
    expect(feedback().length).toBeGreaterThan(0);
    expect(feedback().every(element => element.textContent?.includes(failure === 'server' ? 'Original task is unavailable.' : 'Network unavailable'))).toBe(true);
    expect(document.querySelector(`.run-tab[data-tabid="${FRESH}"]`)).toBeNull();
  });

  it('retains pending state through route redraws and allows a fresh attempt after failure', async () => {
    const pending = deferred<Response>();
    const retry = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(json({ runId: FRESH }));
    const { requests } = await setup(`/runs?run=${FAILED}`, retry);
    buttons()[0]!.click();
    await flush();
    window.history.pushState(null, '', `/runs?run=${SUCCEEDED}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(buttons().length).toBeGreaterThan(0);
    expect(buttons().every(button => button.disabled && button.getAttribute('aria-busy') === 'true')).toBe(true);
    buttons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(writes(requests)).toHaveLength(1);
    pending.resolve(json({ error: 'Try again after the active voyage finishes.' }, 409));
    await flush();
    expect(buttons().every(button => !button.disabled)).toBe(true);
    buttons()[0]!.click();
    await flush();
    expect(writes(requests)).toHaveLength(2);
    expect(new URL(window.location.href).searchParams.get('run')).toBe(FRESH);
  });
});
