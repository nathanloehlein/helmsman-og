import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { DashboardResponse } from './data/live';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed: boolean = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

const realEventSource: typeof globalThis.EventSource | undefined = globalThis.EventSource;
const realFetch: typeof globalThis.fetch | undefined = globalThis.fetch;

async function buildResponse(): Promise<DashboardResponse> {
  const snapshot = await loadMockSnapshot();
  return { snapshot, degraded: [], repos: [snapshot.repo], selectedRepo: null };
}

describe('DashboardView drawer survives polling', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    globalThis.fetch = realFetch as typeof globalThis.fetch;
    document.body.innerHTML = '';
  });

  it('keeps the live drawer open and its stream alive across a poll/paint', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      const payload: unknown = url.includes('/api/agents/launch') ? { runId: 'run-1' } : response;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);

    await view.refresh();
    const launchBtn: HTMLButtonElement | null = root.querySelector<HTMLButtonElement>('.launch-btn');
    expect(launchBtn).not.toBeNull();

    launchBtn!.click();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const drawer: HTMLElement | null = document.body.querySelector<HTMLElement>('.run-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.hidden).toBe(false);

    await view.refresh();

    expect(document.body.querySelector('.run-drawer')).toBe(drawer);
    expect(drawer!.hidden).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });

  it('renders a PR link and ticket status in the drawer footer when the run reaches the gate', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      const payload: unknown = url.includes('/api/agents/launch')
        ? { runId: 'run-1' }
        : url.includes('/api/agents')
          ? { runs: [{ id: 'run-1', status: 'succeeded', prNumber: 42, repo: 'acme/widgets' }] }
          : response;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.launch-btn')!.click();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const stream: FakeEventSource = FakeEventSource.instances[0];
    stream.onmessage?.({
      data: JSON.stringify({ id: 1, runId: 'run-1', ts: new Date().toISOString(), kind: 'run-complete', text: 'succeeded' }),
    } as MessageEvent<string>);

    const footer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer-footer')!;
    await vi.waitFor(() => expect(footer.querySelector('a')).not.toBeNull());

    const link: HTMLAnchorElement = footer.querySelector<HTMLAnchorElement>('a')!;
    expect(link.textContent).toBe('PR #42');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42');
    expect(footer.textContent).toContain('In Review');
  });

  it('closes the drawer and stops the stream when the close button is clicked', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      const payload: unknown = url.includes('/api/agents/launch') ? { runId: 'run-1' } : response;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.launch-btn')!.click();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    const closeBtn: HTMLButtonElement = drawer.querySelector<HTMLButtonElement>('.run-drawer-close')!;
    closeBtn.click();

    expect(drawer.hidden).toBe(true);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
