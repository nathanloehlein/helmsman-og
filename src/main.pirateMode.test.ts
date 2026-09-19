import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | undefined;
let resolveProfile: ((value: Response) => void) | undefined;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
  window.history.replaceState(null, '', '/config?repo=org/app');
  const profile = new Promise<Response>(resolve => { resolveProfile = resolve; });
  const snapshot = await loadDashboard();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/github/profile') return profile;
    if (url.pathname === '/api/context') return json({ repos: ['org/app', 'org/other'], jiraBaseUrl: null });
    if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
    if (url.pathname === '/api/dashboard') return json({ snapshot, repos: ['org/app', 'org/other'], selectedRepo: url.searchParams.get('repo'), degraded: [], jiraBaseUrl: null });
    if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr') return json({ number: Number(url.searchParams.get('number')), repo: url.searchParams.get('repo'), state: 'open', isOwnPr: true, draft: false, merged: false, headRefName: 'topic', reviewDecision: '', comments: 0, checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/app/pull/42' });
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const start = async () => {
  view = new DashboardView(document.querySelector<HTMLElement>('#app')!);
  await view.start();
};
const toggle = (enabled: boolean) => {
  const control = document.querySelector<HTMLButtonElement>('button[data-pirate-mode]');
  expect(control).not.toBeNull();
  if (control?.getAttribute('aria-pressed') !== String(enabled)) control?.click();
};

describe('Pirate mode and greeting', () => {
  it('preserves an unsaved Helm task, mode, repository override, and tuning when toggled in the footer', async () => {
    window.history.replaceState(null, '', '/helm?repo=org/app');
    await start();
    expect(document.querySelector('.app-footer button[data-pirate-mode]')).not.toBeNull();
    const values = [
      ['.newrun-ticket', 'ABC-42'], ['.newrun-title', 'My PR review title'],
      ['.newrun-task', 'Review the agent output\nKeep this unsent task.'],
      ['.newrun-repo', 'org/other'], ['.newrun-model', 'gpt-5.6-sol'], ['.newrun-effort', 'xhigh'],
    ] as const;
    for (const [selector, value] of values) {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
      expect(field, selector).not.toBeNull();
      field!.value = value;
      field!.dispatchEvent(new Event('input', { bubbles: true }));
      field!.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector<HTMLInputElement>('.newrun-mode[value=freeform]')!.click();
    for (const enabled of [false, true]) {
      toggle(enabled);
      expect(document.querySelector('button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe(String(enabled));
      for (const [selector, value] of values) {
        expect(document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value, selector).toBe(value);
      }
      expect(document.querySelector<HTMLInputElement>('.newrun-mode[value=freeform]')?.checked).toBe(true);
      expect(document.querySelector<HTMLInputElement>('.newrun-mode[value=ticket]')?.checked).toBe(false);
      expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/app');
    }
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('preserves unsent PR lookup, review, feedback and tuning fields across mode changes', async () => {
    window.history.replaceState(null, '', '/prs?repo=org/app&pr=42');
    await start();
    const values = [
      ['.pr-lookup-input', 'org/other#88'], ['.pr-review-body', 'Unsent PR review\nKeep my wording.'],
      ['.pr-rerun-feedback', 'Unsent agent feedback'], ['.pr-model', 'sonnet'], ['.pr-effort', 'high'],
    ] as const;
    for (const [selector, value] of values) {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
      expect(field, selector).not.toBeNull();
      field!.value = value;
      field!.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const enabled of [false, true]) {
      toggle(enabled);
      for (const [selector, value] of values) {
        expect(document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value, selector).toBe(value);
      }
      expect(document.querySelector('.pr-panel')?.getAttribute('data-pr-number')).toBe('42');
      expect(new URL(window.location.href).searchParams.get('pr')).toBe('42');
      expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/app');
    }
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('defaults on, switches immediately, preserves unsaved settings and persists across reloads', async () => {
    await start();
    expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    const settings = document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')!;
    settings.value = '7';
    toggle(false);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('PRs');
    expect(document.querySelector('[data-view="dashboard"]')?.textContent).toBe('Dashboard');
    expect(document.querySelector('.repo-select')?.getAttribute('aria-label')).toBe('Scope by repository');
    expect(document.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe('System status');
    expect(document.querySelector('.operator-note')?.textContent).toContain('the agent');
    expect(document.querySelector('[data-footer-running]')?.textContent).toBe('0 running');
    expect(document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')?.value).toBe('7');
    expect(document.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/app');
    expect(localStorage.getItem('helmsman.pirateMode')).toBe('false');
    view?.destroy();
    await start();
    expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('false');
    toggle(true);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    expect(document.querySelector('.operator-note')?.textContent).toContain('the deckhand');
    expect(document.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe('Fleet status');
    expect(document.activeElement).toBe(document.querySelector('[data-pirate-mode]'));
  });

  it('adds an escaped GitHub name without replacing unsaved fields and changes the salutation with the mode', async () => {
    await start();
    const settings = document.querySelector<HTMLInputElement>('[data-key="MAX_ATTEMPTS"] input')!;
    settings.value = '9';
    resolveProfile?.(json({ displayName: 'Pat <img src=x>', login: 'pat' }));
    await vi.waitFor(() => expect(document.querySelector('[data-greeting]')?.textContent).toBe('Ahoy, Pat <img src=x>!'));
    expect(document.querySelector('[data-greeting] img')).toBeNull();
    expect(document.querySelector('[data-key="MAX_ATTEMPTS"] input')).toBe(settings);
    expect(settings.value).toBe('9');
    toggle(false);
    expect(document.querySelector('[data-greeting]')?.textContent).toBe('Hello, Pat <img src=x>!');
  });

  it('blocks mode changes during a pending launch without creating a duplicate voyage', async () => {
    window.history.replaceState(null, '', '/helm?repo=org/app');
    await start();
    document.querySelector<HTMLInputElement>('.newrun-mode[value=freeform]')!.click();
    document.querySelector<HTMLTextAreaElement>('.newrun-task')!.value = 'Launch this task once.';
    let finishLaunch!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishLaunch = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => pending);
    const launch = document.querySelector<HTMLButtonElement>('.newrun-launch')!;
    launch.click();
    expect(launch.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.disabled).toBe(true);
    toggle(false);
    expect(document.querySelector('button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.newrun-launch')).toBe(launch);
    launch.click();
    const launches = () => vi.mocked(fetch).mock.calls.filter(([input, options]) => String(input) === '/api/agents/launch' && options?.method === 'POST');
    expect(launches()).toHaveLength(1);
    finishLaunch(json({ runId: 'run-42' }));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.disabled).toBe(false));
    expect(launches()).toHaveLength(1);
    expect(document.querySelector('[data-tabid="run-42"]')).not.toBeNull();
    toggle(false);
    expect(document.querySelector('button[data-pirate-mode]')?.getAttribute('aria-pressed')).toBe('false');
    expect(launches()).toHaveLength(1);
  });

  it('keeps pending config saves and their failure feedback intact', async () => {
    await start();
    let finishSave!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishSave = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => pending);
    const save = document.querySelector<HTMLButtonElement>('[data-key="MAX_ATTEMPTS"] .config-save')!;
    save.click();
    expect(save.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.disabled).toBe(true);
    toggle(false);
    expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-save')).toBe(save);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    finishSave(new Response(JSON.stringify({ error: 'Unable to save settings' }), { status: 500 }));
    await vi.waitFor(() => expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-error')?.textContent).toBe('Unable to save settings'));
    expect(document.querySelector<HTMLButtonElement>('button[data-pirate-mode]')?.disabled).toBe(false);
    toggle(false);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('PRs');
  });

  it('uses the handle when the profile has no display name', async () => {
    await start();
    resolveProfile?.(json({ displayName: null, login: 'captain-pat' }));
    await vi.waitFor(() => expect(document.querySelector('[data-greeting]')?.textContent).toBe('Ahoy, captain-pat!'));
  });
});
