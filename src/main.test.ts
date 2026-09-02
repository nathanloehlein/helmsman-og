import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { DashboardResponse } from './data/live';
import type { CmuxTabView } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID } from './data/themes';

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

function cmuxTab(over: Partial<CmuxTabView> = {}): CmuxTabView {
  return {
    windowRef: 'win-1',
    workspaceRef: 'ws-1',
    workspaceTitle: 'orchestrator',
    surfaceRef: 'surface-1',
    surfaceTitle: 'main',
    type: 'shell',
    cwd: '/repo',
    selected: false,
    ...over,
  };
}

describe('DashboardView drawer survives polling', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    document.body.innerHTML = '<div id="app"></div>';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  afterEach(() => {
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    globalThis.fetch = realFetch as typeof globalThis.fetch;
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
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

    const emptyDrawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(emptyDrawer.hidden).toBe(false);
    expect(emptyDrawer.querySelectorAll('.run-tab').length).toBe(0);
    expect(emptyDrawer.querySelector('.run-drawer-empty')).not.toBeNull();
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
    expect(drawer.querySelector('.run-tab.is-active .run-tab-label')?.textContent).toContain('TICK-77');
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
    const closeBtn: HTMLButtonElement = drawer.querySelector<HTMLButtonElement>('.run-tab-close')!;
    closeBtn.click();

    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelectorAll('.run-tab').length).toBe(0);
    expect(drawer.querySelector('.run-drawer-empty')).not.toBeNull();
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

  it('does not launch or open the drawer when the ticket ID is blank in ticket mode', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ config: {}, overridden: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const repoSelect: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.newrun-repo')!;
    repoSelect.value = response.snapshot.repo;
    const ticketInput: HTMLInputElement = root.querySelector<HTMLInputElement>('.newrun-ticket')!;
    ticketInput.value = '';

    root.querySelector<HTMLButtonElement>('.newrun-launch')!.click();
    await Promise.resolve();

    expect(fetchMock.mock.calls.some(([requestInput]) => String(requestInput).includes('/api/agents/launch'))).toBe(
      false,
    );
    const emptyDrawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(emptyDrawer.hidden).toBe(false);
    expect(emptyDrawer.querySelectorAll('.run-tab').length).toBe(0);
    expect(emptyDrawer.querySelector('.run-drawer-empty')).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('does not launch or open the drawer when the task is blank in free-form mode', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ config: {}, overridden: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const freeformRadio: HTMLInputElement = root.querySelector<HTMLInputElement>(
      'input.newrun-mode[value="freeform"]',
    )!;
    freeformRadio.checked = true;
    freeformRadio.dispatchEvent(new Event('change'));

    const repoSelect: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.newrun-repo')!;
    repoSelect.value = response.snapshot.repo;
    const taskInput: HTMLTextAreaElement = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    taskInput.value = '';

    root.querySelector<HTMLButtonElement>('.newrun-launch')!.click();
    await Promise.resolve();

    expect(fetchMock.mock.calls.some(([requestInput]) => String(requestInput).includes('/api/agents/launch'))).toBe(
      false,
    );
    const emptyDrawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(emptyDrawer.hidden).toBe(false);
    expect(emptyDrawer.querySelectorAll('.run-tab').length).toBe(0);
    expect(emptyDrawer.querySelector('.run-drawer-empty')).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
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
    expect(drawer.querySelector('.run-tab.is-active .run-tab-label')?.textContent).toContain('TICK-88');
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
          json: async () => ({ config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] }),
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

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
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
    expect(putBody).toEqual({ key: 'AGENT_ADAPTER', value: 'codex' });
  });

  it('shows an inline error and skips refresh when a config save fails', async () => {
    const response: DashboardResponse = await buildResponse();
    let configGetCalls: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config') && init?.method === 'PUT') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid adapter' }),
        } as unknown as Response;
      }
      if (url.includes('/api/config')) {
        configGetCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] }),
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
    expect(configGetCalls).toBe(1);

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(row).not.toBeNull();
    const input: HTMLInputElement = row!.querySelector<HTMLInputElement>('.config-input')!;
    input.value = 'not-a-real-adapter';
    row!.querySelector<HTMLButtonElement>('.config-save')!.click();

    await vi.waitFor(() => {
      expect(row!.querySelector<HTMLElement>('.config-error')?.textContent).toBe('invalid adapter');
    });
    expect(configGetCalls).toBe(1);
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

  it('submits an APPROVE review when the approve button is clicked in the PR lookup panel', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/pr/review')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 42,
            repo: 'org/alpha',
            state: 'open',
            draft: false,
            merged: false,
            headRefName: 'feature-branch',
            reviewDecision: 'REVIEW_REQUIRED',
            comments: 3,
            checks: { passed: 2, failed: 0, pending: 1 },
            url: 'https://github.com/org/alpha/pull/42',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    const goBtn: HTMLButtonElement | null = root.querySelector<HTMLButtonElement>('.pr-lookup-go');
    expect(input).not.toBeNull();
    expect(goBtn).not.toBeNull();
    input!.value = 'org/alpha#42';
    goBtn!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-approve')).not.toBeNull();
    });

    root.querySelector<HTMLButtonElement>('.pr-lookup-result .pr-approve')!.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/api/pr/review'))).toBe(true);
    });

    const reviewCall = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).includes('/api/pr/review'));
    const reviewBody: unknown = JSON.parse((reviewCall![1] as RequestInit).body as string);
    expect(reviewBody).toEqual({ repo: 'org/alpha', number: 42, event: 'APPROVE', body: '' });
  });

  it('does not submit a review when the comment body is empty', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/pr/review')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 42,
            repo: 'org/alpha',
            state: 'open',
            draft: false,
            merged: false,
            headRefName: 'feature-branch',
            reviewDecision: 'REVIEW_REQUIRED',
            comments: 3,
            checks: { passed: 2, failed: 0, pending: 1 },
            url: 'https://github.com/org/alpha/pull/42',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    const goBtn: HTMLButtonElement | null = root.querySelector<HTMLButtonElement>('.pr-lookup-go');
    input!.value = 'org/alpha#42';
    goBtn!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-comment')).not.toBeNull();
    });

    root.querySelector<HTMLButtonElement>('.pr-lookup-result .pr-comment')!.click();

    expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/api/pr/review'))).toBe(false);
  });

  it('reruns with feedback and opens the drawer from the PR lookup panel', async () => {
    const response: DashboardResponse = await buildResponse();
    response.repos = [...response.repos, 'o/r'];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents/launch')) {
        return { ok: true, status: 200, json: async () => ({ runId: 'run-rerun-1' }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 7,
            repo: 'o/r',
            state: 'open',
            draft: false,
            merged: false,
            headRefName: 'feature-branch',
            reviewDecision: 'REVIEW_REQUIRED',
            comments: 0,
            checks: { passed: 1, failed: 0, pending: 0 },
            url: 'https://github.com/o/r/pull/7',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    input!.value = 'o/r#7';
    root.querySelector<HTMLButtonElement>('.pr-lookup-go')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-rerun')).not.toBeNull();
    });

    const feedbackEl: HTMLTextAreaElement | null =
      root.querySelector<HTMLTextAreaElement>('.pr-lookup-result .pr-rerun-feedback');
    expect(feedbackEl).not.toBeNull();
    feedbackEl!.value = 'please fix the lint error';
    root.querySelector<HTMLButtonElement>('.pr-lookup-result .pr-rerun')!.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/api/agents/launch'))).toBe(true);
    });

    const launchCall = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).includes('/api/agents/launch'));
    const launchBody: unknown = JSON.parse((launchCall![1] as RequestInit).body as string);
    expect(launchBody).toEqual({ mode: 'rerun', repo: 'o/r', prNumber: 7, feedback: 'please fix the lint error' });

    await vi.waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    expect(document.querySelector('.run-drawer .run-tab')).not.toBeNull();
  });

  it('launches a code review with the agent and opens the drawer from the PR lookup panel', async () => {
    const response: DashboardResponse = await buildResponse();
    response.repos = [...response.repos, 'o/r'];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents/launch')) {
        return { ok: true, status: 200, json: async () => ({ runId: 'run-review-1' }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 7,
            repo: 'o/r',
            state: 'open',
            draft: false,
            merged: false,
            headRefName: 'feature-branch',
            reviewDecision: 'REVIEW_REQUIRED',
            comments: 0,
            checks: { passed: 1, failed: 0, pending: 0 },
            url: 'https://github.com/o/r/pull/7',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    input!.value = 'o/r#7';
    root.querySelector<HTMLButtonElement>('.pr-lookup-go')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-review-agent')).not.toBeNull();
    });

    root.querySelector<HTMLButtonElement>('.pr-lookup-result .pr-review-agent')!.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/api/agents/launch'))).toBe(true);
    });

    const launchCall = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).includes('/api/agents/launch'));
    const launchBody: unknown = JSON.parse((launchCall![1] as RequestInit).body as string);
    expect(launchBody).toEqual({ mode: 'review', repo: 'o/r', prNumber: 7 });

    await vi.waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    expect(document.querySelector('.run-drawer .run-tab')).not.toBeNull();
  });

  it('fetches and renders a PR panel when a URL is pasted into the lookup and Go is clicked', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 99,
            repo: 'org/beta',
            state: 'merged',
            draft: false,
            merged: true,
            headRefName: 'fix-branch',
            reviewDecision: 'APPROVED',
            comments: 1,
            checks: { passed: 3, failed: 0, pending: 0 },
            url: 'https://github.com/org/beta/pull/99',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    input!.value = 'https://github.com/org/beta/pull/99';
    root.querySelector<HTMLButtonElement>('.pr-lookup-go')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-approve')).not.toBeNull();
    });
    expect(root.querySelector('.pr-lookup-result')?.innerHTML).toContain('#99');
  });

  it('surfaces a review-submit failure in the panel instead of failing silently', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/pr/review')) {
        return { ok: false, status: 403, json: async () => ({ error: 'you cannot approve your own PR' }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 5, repo: 'org/beta', state: 'open', draft: false, merged: false,
            headRefName: 'b', reviewDecision: 'REVIEW_REQUIRED', comments: 0,
            checks: { passed: 0, failed: 0, pending: 0 }, url: 'https://github.com/org/beta/pull/5',
          }),
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

    const input: HTMLInputElement | null = root.querySelector<HTMLInputElement>('.pr-lookup-input');
    input!.value = 'org/beta#5';
    root.querySelector<HTMLButtonElement>('.pr-lookup-go')!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.pr-lookup-result .pr-approve')).not.toBeNull();
    });

    root.querySelector<HTMLButtonElement>('.pr-lookup-result .pr-approve')!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.pr-review-error')?.textContent).toContain('you cannot approve your own PR');
    });
  });

  it('submits an APPROVE review from the drawer PR panel opened via a recent-run row click', async () => {
    const response: DashboardResponse = await buildResponse();
    const terminalRunWithPr = {
      id: 'run-55',
      ticketId: 'TICK-55',
      repo: 'org/alpha',
      status: 'succeeded',
      attempt: 1,
      prNumber: 42,
      startedAt: new Date().toISOString(),
      costUsd: 0.4,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/pr/review')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      if (url.includes('/api/pr?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 42,
            repo: 'org/alpha',
            state: 'open',
            draft: false,
            merged: false,
            headRefName: 'feature-branch',
            reviewDecision: 'REVIEW_REQUIRED',
            comments: 0,
            checks: { passed: 1, failed: 0, pending: 0 },
            url: 'https://github.com/org/alpha/pull/42',
          }),
        } as unknown as Response;
      }
      if (url.includes('/api/agents')) {
        return { ok: true, status: 200, json: async () => ({ runs: [terminalRunWithPr] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const row: HTMLElement | null = root.querySelector<HTMLElement>('.recent-run');
    expect(row).not.toBeNull();
    row!.click();

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    await vi.waitFor(() => {
      expect(drawer.querySelector('.run-drawer-pr .pr-approve')).not.toBeNull();
    });

    drawer.querySelector<HTMLButtonElement>('.run-drawer-pr .pr-approve')!.click();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/api/pr/review'))).toBe(true);
    });

    const reviewCall = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).includes('/api/pr/review'));
    const reviewBody: unknown = JSON.parse((reviewCall![1] as RequestInit).body as string);
    expect(reviewBody).toEqual({ repo: 'org/alpha', number: 42, event: 'APPROVE', body: '' });
  });

  it('keeps the cmux-input node and its value untouched when an SSE tabs-changed event reports an unchanged tab set', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    let tabsCallCount: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        tabsCallCount += 1;
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    input.focus();
    expect(document.activeElement).toBe(input);

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const callsBeforeEvent: number = tabsCallCount;
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ kind: 'cmux-tabs-changed' }),
    } as MessageEvent<string>);
    await vi.waitFor(() => expect(tabsCallCount).toBe(callsBeforeEvent + 1));

    const inputAfter: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    expect(inputAfter).toBe(input);
    expect(inputAfter.value).toBe('draft command');
    expect(document.activeElement).toBe(inputAfter);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('preserves the typed cmux-input value and focus across a repaint triggered by an actual tab-set change', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const tabTwo: CmuxTabView = cmuxTab({ surfaceRef: 'surface-2', surfaceTitle: 'second' });
    let tabsCallCount: number = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        tabsCallCount += 1;
        const tabs: CmuxTabView[] = tabsCallCount <= 1 ? [tabOne] : [tabOne, tabTwo];
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    input.focus();

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ kind: 'cmux-tabs-changed' }),
    } as MessageEvent<string>);

    await vi.waitFor(() => expect(root.querySelectorAll('.cmux-tab').length).toBe(2));

    const inputAfter: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    expect(inputAfter.value).toBe('draft command');
    expect(document.activeElement).toBe(inputAfter);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('shows a placeholder instead of a stale screen when /api/cmux/screen 404s', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: false, status: 404, json: async () => ({ error: 'internal_error' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.cmux-screen')?.textContent).toContain('Screen unavailable');
    });

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('keeps the typed cmux-input value and shows an error when a send fails', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/send')) {
        return { ok: false, status: 400, json: async () => ({ error: 'send failed' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('.cmux-input')).not.toBeNull());

    const input: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    input.value = 'draft command';
    root.querySelector<HTMLButtonElement>('.cmux-send button[type="submit"]')!.click();

    await vi.waitFor(() => expect(root.querySelector('.cmux-error')).not.toBeNull());
    expect(root.querySelector('.cmux-error')?.textContent).toBe('send failed');
    expect(root.querySelector<HTMLInputElement>('.cmux-input')?.value).toBe('draft command');

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('re-enables the action button and shows an error when a cmux action fails', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/action')) {
        return { ok: false, status: 400, json: async () => ({ error: 'action failed' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.cmux-action')).not.toBeNull());

    const actionBtn: HTMLButtonElement = root.querySelector<HTMLButtonElement>('.cmux-action')!;
    actionBtn.click();

    await vi.waitFor(() => expect(root.querySelector('.cmux-error')).not.toBeNull());
    expect(root.querySelector('.cmux-error')?.textContent).toBe('action failed');
    expect(actionBtn.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('sends a mapped key and prevents default when capturing and a surface is selected', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const keyCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/key')) {
        keyCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('true');

    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.dispatchEvent(event);

    await vi.waitFor(() => expect(keyCalls.length).toBe(1));
    expect(keyCalls[0]).toEqual({ surface: tabOne.surfaceRef, key: 'up' });
    expect(event.defaultPrevented).toBe(true);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('sends printable text without enter when capturing', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const sendCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/send')) {
        sendCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();

    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    document.dispatchEvent(event);

    await vi.waitFor(() => expect(sendCalls.length).toBe(1));
    expect(sendCalls[0]).toEqual({ surface: tabOne.surfaceRef, text: 'a', enter: false });
    expect(event.defaultPrevented).toBe(true);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('does nothing on keydown when capture is off', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('false');

    const callsBefore: number = fetchMock.mock.calls.length;
    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.dispatchEvent(event);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(event.defaultPrevented).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('sends a key from the nav keypad button click', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const keyCalls: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/key')) {
        keyCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.cmux-keypad-btn')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-keypad-btn[data-key="down"]')!.click();

    await vi.waitFor(() => expect(keyCalls.length).toBe(1));
    expect(keyCalls[0]).toEqual({ surface: tabOne.surfaceRef, key: 'down' });

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('ignores capture keydown when the send input is focused, leaving normal typing intact', async () => {
    const response: DashboardResponse = await buildResponse();
    const tabOne: CmuxTabView = cmuxTab();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/cmux/tabs')) {
        return { ok: true, status: 200, json: async () => ({ connected: true, tabs: [tabOne] }) } as unknown as Response;
      }
      if (url.includes('/api/cmux/screen')) {
        return { ok: true, status: 200, json: async () => ({ surface: tabOne.surfaceRef, text: 'hello' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="cmux"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.cmux-tab')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('.cmux-tab')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-cmux-capture]')).not.toBeNull());

    root.querySelector<HTMLButtonElement>('[data-cmux-capture]')!.click();
    expect(root.querySelector<HTMLElement>('[data-cmux-capture]')?.getAttribute('aria-pressed')).toBe('true');

    const sendInput: HTMLInputElement = root.querySelector<HTMLInputElement>('.cmux-input')!;
    sendInput.focus();
    expect(document.activeElement).toBe(sendInput);

    const callsBefore: number = fetchMock.mock.calls.length;
    const event: KeyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true, bubbles: true });
    sendInput.dispatchEvent(event);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(event.defaultPrevented).toBe(false);

    root.querySelector<HTMLButtonElement>('.view-toggle[data-view="dashboard"]')!.click();
  });

  it('applies the persisted theme to documentElement before the first paint', async () => {
    localStorage.setItem('cmux.theme', 'dracula');
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);

    expect(document.documentElement.dataset.theme).toBe('dracula');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#bd93f9');

    await view.refresh();
    const select: HTMLSelectElement | null = root.querySelector<HTMLSelectElement>('.theme-select');
    expect(select!.value).toBe('dracula');
  });

  it('defaults to the amber theme when nothing is persisted', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    void new DashboardView(root);

    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });

  it('applies and persists a new theme on select change without a full data refetch', async () => {
    const response: DashboardResponse = await buildResponse();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const select: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.theme-select')!;
    const callsBefore: number = fetchMock.mock.calls.length;

    select.value = 'nord';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#88c0d0');
    expect(localStorage.getItem('cmux.theme')).toBe('nord');
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('DashboardView tabbed runs drawer, config, and repo scope', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    document.body.innerHTML = '<div id="app"></div>';
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  afterEach(() => {
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    globalThis.fetch = realFetch as typeof globalThis.fetch;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function runningRun(id: string, ticketId: string) {
    return {
      id,
      ticketId,
      repo: 'acme/widgets',
      status: 'running',
      attempt: 1,
      prNumber: null,
      startedAt: new Date().toISOString(),
      costUsd: null,
    };
  }

  it('opens one tab per run with independent live streams and no duplicates', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runs: [runningRun('run-a', 'TICK-A'), runningRun('run-b', 'TICK-B')] }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const rows: NodeListOf<HTMLElement> = root.querySelectorAll<HTMLElement>('.agent-row');
    expect(rows.length).toBe(2);
    rows[0].click();
    rows[1].click();

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances.every((s) => !s.closed)).toBe(true);

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelectorAll('.run-tab').length).toBe(2);
    expect(drawer.querySelector('.run-tab.is-active .run-tab-label')?.textContent).toContain('TICK-B');

    rows[0].click();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(drawer.querySelector('.run-tab.is-active .run-tab-label')?.textContent).toContain('TICK-A');
  });

  it('activates a neighbor when the active tab is closed and hides the drawer when the last closes', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runs: [runningRun('run-a', 'TICK-A'), runningRun('run-b', 'TICK-B')] }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const rows: NodeListOf<HTMLElement> = root.querySelectorAll<HTMLElement>('.agent-row');
    rows[0].click();
    rows[1].click();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    drawer.querySelector<HTMLButtonElement>('.run-tab[data-tabid="run-b"] .run-tab-close')!.click();
    expect(drawer.querySelectorAll('.run-tab').length).toBe(1);
    expect(drawer.querySelector('.run-tab.is-active .run-tab-label')?.textContent).toContain('TICK-A');

    drawer.querySelector<HTMLButtonElement>('.run-tab[data-tabid="run-a"] .run-tab-close')!.click();
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelectorAll('.run-tab').length).toBe(0);
    expect(drawer.querySelector('.run-drawer-empty')).not.toBeNull();
    expect(FakeEventSource.instances.every((s) => s.closed)).toBe(true);
  });

  it('toggles config collapsed and persists it', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/config')) return { ok: true, status: 200, json: async () => ({ config: { A: '1' }, overridden: [] }) } as unknown as Response;
      if (url.includes('/api/agents')) return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const toggle: HTMLButtonElement = root.querySelector<HTMLButtonElement>('.config-toggle')!;
    expect(root.querySelector('.config-panel.is-collapsed')).toBeNull();
    toggle.click();
    expect(root.querySelector('.config-panel.is-collapsed')).not.toBeNull();
    expect(localStorage.getItem('runner.configCollapsed')).toBe('1');
    toggle.click();
    expect(root.querySelector('.config-panel.is-collapsed')).toBeNull();
    expect(localStorage.getItem('runner.configCollapsed')).toBe('0');
  });

  it('fires a drawer PR action exactly once (no double-handling now the drawer lives in root)', async () => {
    const response: DashboardResponse = await buildResponse();
    let reviewLaunches: number = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents/launch')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { mode?: string };
        if (body.mode === 'review') reviewLaunches += 1;
        return { ok: true, status: 200, json: async () => ({ runId: 'run-x' }) } as unknown as Response;
      }
      if (url.includes('/api/agents')) return { ok: true, status: 200, json: async () => ({ runs: [runningRun('run-a', 'TICK-A')] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();
    root.querySelector<HTMLElement>('.agent-row')!.click();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const drawer: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer')!;
    const prEl: HTMLElement = drawer.querySelector<HTMLElement>('.run-drawer-pr')!;
    prEl.innerHTML = '<div class="pr-panel" data-pr-repo="acme/widgets" data-pr-number="7"><button class="pr-review-agent">Code-review with agent</button></div>';
    drawer.querySelector<HTMLButtonElement>('.pr-review-agent')!.click();

    await vi.waitFor(() => expect(reviewLaunches).toBe(1));
    expect(reviewLaunches).toBe(1);
  });

  it('persists repo scope and re-requests it on a fresh view', async () => {
    const response: DashboardResponse = await buildResponse();
    const scoped: string[] = ['acme/widgets', 'acme/other'];
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/dashboard')) {
        const match: RegExpMatchArray | null = url.match(/repo=([^&]+)/);
        const repo: string | null = match ? decodeURIComponent(match[1]) : null;
        return { ok: true, status: 200, json: async () => ({ ...response, repos: scoped, selectedRepo: repo }) } as unknown as Response;
      }
      if (url.includes('/api/agents')) return { ok: true, status: 200, json: async () => ({ runs: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();

    const select: HTMLSelectElement = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'acme/other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(localStorage.getItem('runner.repoScope')).toBe('acme/other'));

    document.body.innerHTML = '<div id="app"></div>';
    const root2: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view2: DashboardView = new DashboardView(root2);
    await view2.refresh();
    expect(fetchMock.mock.calls.some(([i]) => String(i).includes('/api/dashboard?repo=acme%2Fother'))).toBe(true);
  });

  it('keeps the log pinned to the bottom across repaints, but honors a user scroll-back', async () => {
    const response: DashboardResponse = await buildResponse();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url: string = String(input);
      if (url.includes('/api/agents')) return { ok: true, status: 200, json: async () => ({ runs: [runningRun('run-a', 'TICK-A')] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => response } as unknown as Response;
    }) as typeof globalThis.fetch;

    const root: HTMLElement = document.querySelector<HTMLElement>('#app')!;
    const view: DashboardView = new DashboardView(root);
    await view.refresh();
    root.querySelector<HTMLElement>('.agent-row')!.click();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const body: HTMLElement = document.body.querySelector<HTMLElement>('.run-drawer-body')!;
    let top: number = 0;
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 100 });

    const emit = (text: string): void => FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ id: top, runId: 'run-a', ts: new Date().toISOString(), kind: 'stdout', text }),
    } as MessageEvent<string>);

    emit('line 1');
    expect(top).toBe(1000);

    top = 200;
    body.dispatchEvent(new Event('scroll'));
    emit('line 2');
    expect(top).toBe(200);

    await view.refresh();
    expect(top).toBe(200);

    top = 1000;
    body.dispatchEvent(new Event('scroll'));
    await view.refresh();
    expect(top).toBe(1000);
  });
});
