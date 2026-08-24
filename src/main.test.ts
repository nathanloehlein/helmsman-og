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
      data: JSON.stringify({ id: 1, ts: new Date().toISOString(), kind: 'run-complete', text: 'succeeded' }),
    } as MessageEvent<string>);

    const footer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer-footer')!;
    await vi.waitFor(() => expect(footer.querySelector('a')).not.toBeNull());

    const link: HTMLAnchorElement = footer.querySelector<HTMLAnchorElement>('a')!;
    expect(link.textContent).toBe('PR #42');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42');
    expect(footer.textContent).toContain('In Review');
  });

  it('stops a running agent without opening the drawer', async () => {
    const response: DashboardResponse = await buildResponse();
    const runningRun = {
      id: 'run-42',
      ticketId: 'TICK-42',
      repo: 'acme/widgets',
      status: 'running',
      attempt: 1,
      prNumber: null,
      startedAt: new Date().toISOString(),
      costUsd: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/stop')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [runningRun] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const stopBtn: HTMLButtonElement | null = root.querySelector<HTMLButtonElement>('.agent-stop');
    expect(stopBtn).not.toBeNull();
    stopBtn!.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([requestInput]) => String(requestInput).includes('/run-42/stop'))).toBe(true);
    });

    expect(document.body.querySelector<HTMLElement>('.run-drawer')!.hidden).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens the drawer and streams logs when a running-agent row is clicked', async () => {
    const response: DashboardResponse = await buildResponse();
    const runningRun = {
      id: 'run-77',
      ticketId: 'TICK-77',
      repo: 'acme/widgets',
      status: 'running',
      attempt: 1,
      prNumber: null,
      startedAt: new Date().toISOString(),
      costUsd: null,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [runningRun] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.agent-row');
    expect(row).not.toBeNull();
    row!.click();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain('run-77');

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelector('.run-drawer-title')?.textContent).toContain('TICK-77');
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

  it('launches a free-form run, posts the expected body, and opens the drawer', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents/launch')) {
        return { ok: true, status: 200, json: async () => ({ runId: 'run-99' }) } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ config: {}, overridden: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const freeformRadio: HTMLInputElement | null = root.querySelector<HTMLInputElement>(
      'input.newrun-mode[value="freeform"]',
    );
    expect(freeformRadio).not.toBeNull();
    freeformRadio!.checked = true;
    freeformRadio!.dispatchEvent(new Event('change'));

    const repoSelect: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.newrun-repo')!;
    repoSelect.value = response.snapshot.repo;
    const taskInput: HTMLTextAreaElement = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    taskInput.value = 'Write a changelog';

    root.querySelector<HTMLButtonElement>('.newrun-launch')!.click();

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const launchCall = fetchMock.mock.calls.find(([requestInput]) => String(requestInput).includes('/api/agents/launch'));
    expect(launchCall).toBeDefined();
    const launchBody: unknown = JSON.parse((launchCall![1] as RequestInit).body as string);
    expect(launchBody).toMatchObject({ repo: response.snapshot.repo, task: 'Write a changelog', mode: 'freeform' });

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(drawer.hidden).toBe(false);
    expect(FakeEventSource.instances[0].url).toContain('run-99');
  });

  it('opens the drawer and streams logs when a recent-run row is clicked', async () => {
    const response: DashboardResponse = await buildResponse();
    const terminalRun = {
      id: 'run-88',
      ticketId: 'TICK-88',
      repo: 'acme/widgets',
      status: 'succeeded',
      attempt: 1,
      prNumber: null,
      startedAt: new Date().toISOString(),
      costUsd: 0.4,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [terminalRun] }) } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ config: {}, overridden: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.recent-run');
    expect(row).not.toBeNull();
    row!.click();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain('run-88');

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelector('.run-drawer-title')?.textContent).toContain('TICK-88');
  });

  it('saves a config value and refreshes', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config') && init?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { agentAdapter: 'claude-code' }, overridden: [] }),
        } as unknown as Response;
      }
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="agentAdapter"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = 'codex';
    row!.querySelector<HTMLButtonElement>('.config-save')!.click();

    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([requestInput, requestInit]) =>
            String(requestInput).includes('/api/config') && (requestInit as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true);
    });

    const putCall = fetchMock.mock.calls.find(
      ([requestInput, requestInit]) =>
        String(requestInput).includes('/api/config') && (requestInit as RequestInit | undefined)?.method === 'PUT',
    );
    const putBody: unknown = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(putBody).toEqual({ key: 'agentAdapter', value: 'codex' });
  });

  it('posts to the auto-claim endpoint when the toggle is switched off', async () => {
    const response: DashboardResponse = await buildResponse();
    const scopedResponse: DashboardResponse = { ...response, repos: ['org/alpha'], selectedRepo: 'org/alpha' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/auto-claim')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [], autoClaim: ['org/alpha'] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => scopedResponse } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const toggle: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.auto-claim-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(true);

    toggle!.checked = false;
    toggle!.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([requestInput]) => String(requestInput).includes('/api/repos/org%2Falpha/auto-claim')),
      ).toBe(true);
    });
  });
});
