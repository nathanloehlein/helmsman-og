import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { RunSummary } from './data/agents';

const FIRST = '550e8400-e29b-41d4-a716-446655440001';
const SECOND = '550e8400-e29b-41d4-a716-446655440002';
const THIRD = '550e8400-e29b-41d4-a716-446655440003';
const streams: RunStream[] = [];
const views: DashboardView[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value));
let originalClipboard: PropertyDescriptor | undefined;

class RunStream {
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();
  constructor(url: string) { this.url = url; streams.push(this); }
  complete(status: string): void {
    this.onmessage?.({ data: JSON.stringify({ id: 1, runId: this.url.split('/').at(-2), ts: '2026-09-18T00:00:00Z', kind: 'run-complete', text: status }) } as MessageEvent<string>);
  }
}

function run(id: string, status = 'running'): RunSummary {
  return { id, ticketId: `TASK-${id.at(-1)}`, repo: 'org/repo', status, attempt: 1, prNumber: null, startedAt: '2026-09-18T00:00:00Z', costUsd: null };
}

async function setup(path = `/runs?run=${FIRST}`, runs = [run(FIRST), run(SECOND), run(THIRD)], details = new Map(runs.map(item => [item.id, item]))) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadDashboard();
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected write');
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/context') return json({ repos: ['org/repo'], jiraBaseUrl: null, jiraEnabled: true });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo'], selectedRepo: null, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') {
      const filtered = runs.filter(run => !url.searchParams.get('repo') || run.repo === url.searchParams.get('repo'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ runs: filtered.slice(offset, offset + 25), total: filtered.length, limit: 25, offset });
    }
    if (url.pathname.startsWith('/api/agents/')) {
      const detail = details.get(url.pathname.split('/').at(-1) ?? '');
      return detail ? json(detail) : new Response(null, { status: 404 });
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
  return { writeText, details };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  streams.length = 0;
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  vi.stubGlobal('EventSource', RunStream);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const flush = () => vi.advanceTimersByTimeAsync(40);
const tab = (id: string) => document.querySelector<HTMLElement>(`.run-tab[data-tabid="${id}"]`)!;
const select = (id: string) => tab(id).querySelector<HTMLButtonElement>('.run-tab-select')!;
const copy = (element: ParentNode, id: string) => element.querySelector<HTMLButtonElement>(`[data-copy-run-id="${id}"]`)!;

async function open(id: string): Promise<void> {
  window.history.pushState(null, '', `/runs?run=${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
  await flush();
}

describe('voyage drawer interactions', () => {
  it.each([
    ['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes'], ['COMMENT', 'Comment only'],
  ] as const)('shows the saved %s recommendation when opening a completed recent run', async (reviewOutcome, label) => {
    await setup(`/runs?run=${FIRST}`, [{ ...run(FIRST, 'succeeded'), reviewOutcome }]);
    expect(tab(FIRST).dataset.runStatus).toBe('succeeded');
    const badge = tab(FIRST).querySelector<HTMLElement>('.run-tab-status');
    expect(badge?.textContent).toBe(label);
    expect(badge?.dataset.reviewOutcome).toBe(reviewOutcome);
    expect(badge?.title).toContain(`recommendation: ${label}`);
  });

  it('loads a historical recommendation outside recent history from the individual run endpoint', async () => {
    await setup(`/runs?run=${FIRST}`, [], new Map([[FIRST, { ...run(FIRST, 'succeeded'), reviewOutcome: 'REQUEST_CHANGES' }]]));
    expect(tab(FIRST).dataset.runStatus).toBe('succeeded');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Request changes');
    expect(tab(FIRST).querySelector<HTMLElement>('.run-tab-status')?.dataset.reviewOutcome).toBe('REQUEST_CHANGES');
  });

  it('updates an inactive review tab on completion and preserves the recommendation when selecting it again', async () => {
    const { details } = await setup();
    await open(SECOND);
    details.set(FIRST, { ...run(FIRST, 'succeeded'), reviewOutcome: 'COMMENT' });
    streams[0]!.complete('succeeded');
    await flush();
    expect(select(SECOND).getAttribute('aria-selected')).toBe('true');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Comment only');
    expect(tab(FIRST).querySelector<HTMLElement>('.run-tab-status')?.dataset.reviewOutcome).toBe('COMMENT');
    select(FIRST).click();
    await flush();
    expect(select(FIRST).getAttribute('aria-selected')).toBe('true');
    expect(tab(FIRST).dataset.runStatus).toBe('succeeded');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Comment only');
    expect(tab(FIRST).querySelector<HTMLElement>('.run-tab-status')?.dataset.reviewOutcome).toBe('COMMENT');
  });

  it('keeps a failed review tab labeled as failed despite a saved recommendation', async () => {
    await setup(`/runs?run=${FIRST}`, [{ ...run(FIRST, 'failed'), reviewOutcome: 'APPROVE' }]);
    expect(tab(FIRST).dataset.runStatus).toBe('failed');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Marooned');
    expect(tab(FIRST).querySelector<HTMLElement>('.run-tab-status')?.dataset.reviewOutcome).toBeFalsy();
  });

  it('copies the full UUID from an inactive tab without selecting it or changing the route', async () => {
    const { writeText } = await setup();
    await open(SECOND);
    const address = window.location.href;
    const button = copy(tab(FIRST), FIRST);
    expect(button).not.toBeNull();
    button.click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect(window.location.href).toBe(address);
    expect(select(SECOND).getAttribute('aria-selected')).toBe('true');
    expect(select(FIRST).getAttribute('aria-selected')).toBe('false');
    expect(button.dataset.copyState).toBe('copied');
    expect(tab(FIRST).querySelector('.voyage-copy-feedback[role="status"]')?.textContent).toBe('Copied');
  });

  it('copies a recent voyage UUID without opening its drawer or leaving Helm', async () => {
    const { writeText } = await setup('/', [run(FIRST, 'failed')]);
    const row = document.querySelector<HTMLElement>(`.recent-run[data-runid="${FIRST}"]`)!;
    const address = window.location.href;
    const button = copy(row, FIRST);
    expect(button).not.toBeNull();
    button.click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect(window.location.href).toBe(address);
    expect(streams).toHaveLength(0);
    expect(button.dataset.copyState).toBe('copied');
    expect(row.querySelector('.voyage-copy-feedback[role="status"]')?.textContent).toBe('Copied');
  });

  it('shows copy failure when clipboard access is denied without changing selection', async () => {
    const { writeText } = await setup();
    writeText.mockRejectedValue(new DOMException('Clipboard denied', 'NotAllowedError'));
    const address = window.location.href;
    const button = copy(tab(FIRST), FIRST);
    button.click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect(button.dataset.copyState).toBe('error');
    expect(tab(FIRST).querySelector('.voyage-copy-feedback[role="status"]')?.textContent).toBe('Copy failed');
    expect(window.location.href).toBe(address);
    expect(select(FIRST).getAttribute('aria-selected')).toBe('true');
  });

  it.each([['failed', 'Marooned'], ['succeeded', 'Shipshape'], ['stopped', 'Stopped']])('updates a running tab to %s when its stream completes', async (status, label) => {
    const { details } = await setup();
    expect(tab(FIRST).dataset.runStatus).toBe('running');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Underway');
    details.set(FIRST, run(FIRST, status));
    streams[0]!.complete(status);
    await flush();
    expect(tab(FIRST).dataset.runStatus).toBe(status);
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe(label);
    expect(document.querySelector('.run-drawer-footer')?.textContent).toContain(label);
    expect(streams[0]?.close).toHaveBeenCalled();
  });

  it('uses the canonical getRun status when a completion event has no recognized status', async () => {
    const { details } = await setup();
    details.set(FIRST, run(FIRST, 'failed'));
    streams[0]!.complete('finished');
    await flush();
    expect(tab(FIRST).dataset.runStatus).toBe('failed');
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe('Marooned');
  });

  it.each([['failed', 'Marooned'], ['succeeded', 'Shipshape'], ['running', 'Underway']])('opens a directly linked historical voyage using its %s getRun status', async (status, label) => {
    await setup(`/runs?run=${FIRST}`, [], new Map([[FIRST, run(FIRST, status)]]));
    expect(tab(FIRST).dataset.runStatus).toBe(status);
    expect(tab(FIRST).querySelector('.run-tab-status')?.textContent).toBe(label);
  });

  it('supports ArrowLeft/Right, Home, and End with selection, route, and focus kept together', async () => {
    await setup();
    await open(SECOND);
    await open(THIRD);
    select(FIRST).click();
    select(FIRST).focus();
    for (const [key, expected] of [['ArrowRight', SECOND], ['ArrowLeft', FIRST], ['ArrowLeft', THIRD], ['Home', FIRST], ['End', THIRD]]) {
      const current = document.querySelector<HTMLButtonElement>('.run-tab-select[aria-selected="true"]')!;
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      current.dispatchEvent(event);
      await flush();
      const active = select(expected!);
      expect(event.defaultPrevented).toBe(true);
      expect(active.getAttribute('aria-selected')).toBe('true');
      expect(active.tabIndex).toBe(0);
      expect(document.activeElement).toBe(active);
      expect(new URL(window.location.href).searchParams.get('run')).toBe(expected);
      expect(document.querySelectorAll('.run-tab-select[tabindex="0"]')).toHaveLength(1);
    }
  });
});
