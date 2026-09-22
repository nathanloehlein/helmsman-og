import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import type { FirefoxBridgeStatus } from './data/firefoxBridge';

let view: DashboardView | null = null;
const stopped: FirefoxBridgeStatus = { status: 'stopped', bridgeRunning: false, firefoxReady: true, canStart: true, message: 'Bridge stopped. Firefox automation is available.' };
const running: FirefoxBridgeStatus = { status: 'running', bridgeRunning: true, firefoxReady: true, canStart: false, message: 'Bridge running. Firefox automation is available.' };

async function setup(options: { browser?: string; status?: FirefoxBridgeStatus | null; start?: () => Promise<Response> } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/api/slack/firefox-bridge') {
      calls.push(init?.method ?? 'GET');
      return init?.method === 'POST' ? options.start?.() ?? Response.json(running) : Response.json(options.status === undefined ? stopped : options.status);
    }
    if (path === '/api/config') return Response.json({ config: { SLACK_BROWSER: options.browser ?? 'firefox', AGENT_CMD: 'codex exec' }, overridden: [] });
    if (path === '/api/context') return Response.json({ repos: ['org/a'], jiraEnabled: true, jiraBaseUrl: null });
    if (path === '/api/agents') return Response.json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (path === '/api/repo/local') return Response.json({ repo: 'org/a', path: null, branches: [], worktrees: [], error: null });
    return new Response(null, { status: 404 });
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  await vi.waitFor(() => expect(root.querySelector('#config-SLACK_BROWSER')).not.toBeNull());
  return { root, calls };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/config?repo=org/a');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => {
  view?.destroy(); view = null;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Firefox bridge Config controls', () => {
  it('reads status automatically and starts only after a click, preserving drafts and scope', async () => {
    const { root, calls } = await setup();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')?.disabled).toBe(false));
    expect(calls.every(call => call === 'GET')).toBe(true);
    const field = root.querySelector<HTMLInputElement>('#config-AGENT_CMD')!;
    field.value = 'unsaved command';
    root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-firefox-bridge]')?.textContent).toContain('Bridge running.'));
    expect(calls.filter(call => call === 'POST')).toHaveLength(1);
    expect(field.value).toBe('unsaved command');
    expect(new URLSearchParams(window.location.search).get('repo')).toBe('org/a');
    expect(root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')?.disabled).toBe(true);
  });

  it('shows an actionable unavailable state and blocks start until a fresh status succeeds', async () => {
    const { root, calls } = await setup({ status: null });
    await vi.waitFor(() => expect(root.querySelector('[data-firefox-bridge] [role=alert]')?.textContent).toContain('unavailable'));
    expect(root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-firefox-bridge-check]')!.click();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(calls).not.toContain('POST');
  });

  it('disables duplicate start clicks while startup is pending', async () => {
    let resolve!: (response: Response) => void;
    const { root, calls } = await setup({ start: () => new Promise(done => { resolve = done; }) });
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')?.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')!.click();
    root.querySelector<HTMLButtonElement>('[data-firefox-bridge-start]')!.click();
    expect(calls.filter(call => call === 'POST')).toHaveLength(1);
    expect(root.querySelector('[data-firefox-bridge]')?.textContent).toContain('Starting Firefox bridge');
    resolve(Response.json(running));
    await vi.waitFor(() => expect(root.querySelector('[data-firefox-bridge]')?.textContent).toContain('Bridge running.'));
  });

  it('does not probe Firefox when the selected Slack browser is cmux', async () => {
    const { root, calls } = await setup({ browser: 'cmux' });
    expect(root.querySelector('[data-firefox-bridge]')).toBeNull();
    expect(calls).toEqual([]);
  });
});
