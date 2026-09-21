import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';

class RunStream {
  static instances: RunStream[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  close = vi.fn(() => { this.readyState = 2; });
  fail(): void { this.readyState = 2; this.onerror?.(new Event('error')); }
  open(): void { this.readyState = 1; this.onopen?.(new Event('open')); }
  readonly url: string;
  constructor(url: string) { this.url = url; RunStream.instances.push(this); }
  emit(id: number, kind = 'stdout', text = `line ${id}`): void {
    this.onmessage?.({ data: JSON.stringify({ id, runId: this.url.split('/').at(-2), ts: '2026-09-17T00:00:00Z', kind, text }) } as MessageEvent<string>);
  }
}

let view: DashboardView;
let hidden = false;
const json = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  window.history.replaceState(null, '', '/runs?run=run-a');
  RunStream.instances = [];
  vi.stubGlobal('EventSource', RunStream);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/context') return json({ repos: ['org/repo'], jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [
      { id: 'run-a', ticketId: 'A', repo: 'org/repo', status: 'running', prNumber: null },
      { id: 'run-b', ticketId: 'B', repo: 'org/repo', status: 'running', prNumber: null },
    ] });
    if (url.pathname.startsWith('/api/agents/')) return json({ id: url.pathname.split('/').at(-1), status: 'succeeded', repo: 'org/repo', prNumber: null });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    return json({});
  }));
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
  await view.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  vi.useFakeTimers();
});

afterEach(() => {
  view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const body = () => document.querySelector<HTMLElement>('.run-drawer-body')!;
const flush = () => vi.advanceTimersByTimeAsync(40);

describe('bounded voyage log rendering', () => {
  it('recovers when output is requested before a newly launched run exists', async () => {
    expect(document.querySelector('.run-stream-status')?.textContent).toBe('Connecting to output…');
    RunStream.instances[0]!.fail();
    expect(document.querySelector('.run-stream-status')?.textContent).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(RunStream.instances).toHaveLength(2);
    RunStream.instances[1]!.open();
    expect(document.querySelector('.run-stream-status')?.textContent).toBe('Connected. Waiting for output…');
    RunStream.instances[1]!.emit(1, 'phase', 'Preparing worktree');
    await flush();
    expect(body().textContent).toBe('Preparing worktree');
    expect(document.querySelector<HTMLElement>('.run-stream-status')?.hidden).toBe(true);
  });

  it('offers reconnection after repeated failures without relaunching or duplicating saved output', async () => {
    RunStream.instances[0]!.emit(1);
    await flush();
    for (let attempt = 0; attempt < 6; attempt++) {
      RunStream.instances.at(-1)!.fail();
      await vi.advanceTimersByTimeAsync(8000);
    }
    const reconnect = document.querySelector<HTMLButtonElement>('[data-reconnect-run-output]');
    expect(reconnect?.textContent).toBe('Reconnect output');
    expect(document.querySelector('.run-stream-status')?.textContent).toContain('may still be preparing or running');
    reconnect!.click();
    RunStream.instances.at(-1)!.emit(1);
    RunStream.instances.at(-1)!.emit(2);
    await flush();
    expect([...body().children].map(line => line.textContent)).toEqual(['line 1', 'line 2']);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('highlights batched output safely and preserves existing rows on append', async () => {
    const text = '{"html": "<img src=x onerror=alert(1)>", "code": 42}';
    RunStream.instances[0]!.emit(1, 'log', text);
    expect(body().children).toHaveLength(0);
    await flush();
    const row = body().firstElementChild;
    expect(row?.textContent).toBe(text);
    expect(row?.querySelector('.log-token-key')?.textContent).toBe('"html"');
    expect(row?.querySelector('img')).toBeNull();
    RunStream.instances[0]!.emit(2, 'error', 'const message = "failed"');
    await flush();
    expect(body().firstElementChild).toBe(row);
    expect(body().lastElementChild?.classList.contains('run-line-error')).toBe(true);
    expect(body().lastElementChild?.children).toHaveLength(0);
  });

  it('batches thousands of events, retains the latest 300, and completes without replacing the drawer', async () => {
    const log = body();
    const height = vi.spyOn(log, 'scrollHeight', 'get');
    for (let id = 1; id <= 5000; id++) RunStream.instances[0]!.emit(id);
    expect(log.children).toHaveLength(0);
    expect(height).not.toHaveBeenCalled();
    await flush();
    expect(log.children).toHaveLength(300);
    expect(log.firstElementChild?.textContent).toBe('line 4701');
    expect(log.lastElementChild?.textContent).toBe('line 5000');
    expect(height).toHaveBeenCalledTimes(1);
    const retainedLine = log.lastElementChild;
    RunStream.instances[0]!.emit(5001, 'run-complete');
    await flush();
    expect(body()).toBe(log);
    expect(log.children).toHaveLength(300);
    expect(log.children[298]).toBe(retainedLine);
    expect(log.lastElementChild?.textContent).toBe('line 5001');
    expect(document.querySelector('.run-tab[data-run-status="succeeded"]')).not.toBeNull();
    expect(document.querySelector('.run-drawer-footer')?.textContent).toContain('Shipshape');
    expect(RunStream.instances[0]!.close).toHaveBeenCalled();
  });

  it('preserves a reader’s scroll position while appending and when old rows are evicted', async () => {
    for (let id = 1; id <= 300; id++) RunStream.instances[0]!.emit(id);
    await flush();
    const log = body();
    vi.spyOn(log, 'scrollHeight', 'get').mockImplementation(() => log.children.length * 20);
    vi.spyOn(log, 'clientHeight', 'get').mockReturnValue(100);
    log.scrollTop = 1000;
    log.dispatchEvent(new Event('scroll'));
    const reading = log.children[50];
    RunStream.instances[0]!.emit(301);
    await flush();
    expect(log.scrollTop).toBe(980);
    expect(log.children[49]).toBe(reading);
  });

  it('buffers while hidden and renders only the latest window on visibility restoration', async () => {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    for (let id = 1; id <= 5000; id++) RunStream.instances[0]!.emit(id);
    await flush();
    expect(body().children).toHaveLength(0);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(body().children).toHaveLength(300);
    expect(body().firstElementChild?.textContent).toBe('line 4701');
  });

  it('switches voyages without rendering the old batch into the new tab', async () => {
    for (let id = 1; id <= 5000; id++) RunStream.instances[0]!.emit(id);
    window.history.pushState(null, '', '/runs?run=run-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(RunStream.instances).toHaveLength(2);
    expect(body().children).toHaveLength(0);
    RunStream.instances[1]!.emit(10);
    await flush();
    expect(body().textContent).toBe('line 10');
    document.querySelector<HTMLButtonElement>('.run-tab-select[data-tabid="run-a"]')!.click();
    await flush();
    expect(body().children).toHaveLength(300);
    expect(body().firstElementChild?.textContent).toBe('line 4701');
    expect(body().lastElementChild?.textContent).toBe('line 5000');
  });

  it('does not render while another page is open, then catches up when returning', async () => {
    document.querySelector<HTMLAnchorElement>('[data-view="config"]')!.click();
    await flush();
    const log = document.querySelector('.run-drawer-body');
    expect(log).toBeNull();
    for (let id = 1; id <= 5000; id++) RunStream.instances[0]!.emit(id);
    await flush();
    window.history.pushState(null, '', '/runs?run=run-a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(body().children).toHaveLength(300);
    expect(body().firstElementChild?.textContent).toBe('line 4701');
  });

  it('cancels pending work on close and ignores late stream callbacks', async () => {
    const log = body();
    RunStream.instances[0]!.emit(1);
    document.querySelector<HTMLButtonElement>('.run-tab-close')!.click();
    RunStream.instances[0]!.emit(2);
    await flush();
    expect(log.children).toHaveLength(0);
    expect(document.querySelector('.run-drawer-empty')).not.toBeNull();
    expect(RunStream.instances[0]!.close).toHaveBeenCalled();
  });

  it('cancels pending work and rejects late events after destruction', async () => {
    const log = body();
    RunStream.instances[0]!.emit(1);
    view.destroy();
    RunStream.instances[0]!.emit(2);
    await flush();
    expect(log.children).toHaveLength(0);
  });
});
