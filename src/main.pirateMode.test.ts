import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | undefined;
let resolveProfile: ((value: Response) => void) | undefined;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/config?repo=org/app');
  const profile = new Promise<Response>(resolve => { resolveProfile = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/github/profile') return profile;
    if (url.pathname === '/api/context') return json({ repos: ['org/app'], jiraBaseUrl: null });
    if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
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
  const control = document.querySelector<HTMLInputElement>('[data-pirate-mode]')!;
  control.checked = enabled;
  control.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('Pirate mode and greeting', () => {
  it('defaults on, switches immediately, preserves unsaved settings and persists across reloads', async () => {
    await start();
    expect(document.querySelector<HTMLInputElement>('[data-pirate-mode]')?.checked).toBe(true);
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
    expect(document.querySelector<HTMLInputElement>('[data-pirate-mode]')?.checked).toBe(false);
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

  it('keeps pending config saves and their failure feedback intact', async () => {
    await start();
    let finishSave!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishSave = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async () => pending);
    const save = document.querySelector<HTMLButtonElement>('[data-key="MAX_ATTEMPTS"] .config-save')!;
    save.click();
    expect(save.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-pirate-mode]')?.disabled).toBe(true);
    toggle(false);
    expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-save')).toBe(save);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('Bounties');
    finishSave(new Response(JSON.stringify({ error: 'Unable to save settings' }), { status: 500 }));
    await vi.waitFor(() => expect(document.querySelector('[data-key="MAX_ATTEMPTS"] .config-error')?.textContent).toBe('Unable to save settings'));
    expect(document.querySelector<HTMLInputElement>('[data-pirate-mode]')?.disabled).toBe(false);
    toggle(false);
    expect(document.querySelector('[data-view="prs"]')?.textContent).toBe('PRs');
  });

  it('uses the handle when the profile has no display name', async () => {
    await start();
    resolveProfile?.(json({ displayName: null, login: 'captain-pat' }));
    await vi.waitFor(() => expect(document.querySelector('[data-greeting]')?.textContent).toBe('Ahoy, captain-pat!'));
  });
});
