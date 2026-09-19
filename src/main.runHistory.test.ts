import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import type { RunSummary } from './data/agents';

const views: DashboardView[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const run = (index: number, repo = 'org/a'): RunSummary => ({
  id: `run-${repo.endsWith('b') ? 'b' : 'a'}-${index}`, ticketId: `TASK-${index}`, repo, status: 'succeeded', attempt: 1,
  prNumber: null, startedAt: new Date(Date.UTC(2026, 8, 19, 0, 0, 100 - index)).toISOString(), costUsd: null,
});
const items = Array.from({ length: 62 }, (_, index) => run(index));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const page = (url: URL, rows = items) => {
  const filtered = rows.filter(item => !url.searchParams.get('repo') || item.repo === url.searchParams.get('repo'));
  const offset = Number(url.searchParams.get('offset'));
  return json({ runs: filtered.slice(offset, offset + 25), offset, limit: 25, total: filtered.length });
};
function setup(extra: (url: URL) => Response | Promise<Response> | null = () => null, path = '/runs?repo=org/a') {
  window.history.replaceState(null, '', path);
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url);
    const custom = extra(url);
    if (custom) return custom;
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraEnabled: true, jiraBaseUrl: null });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/agents') return json({ runs: items.slice(0, 2), autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/runs') return page(url, [...items, run(0, 'org/b')]);
    if (url.pathname.startsWith('/api/agents/')) return json(items.find(item => item.id === url.pathname.split('/').at(-1)));
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  return { root, view, requests, started: view.start() };
}
const range = () => document.querySelector('.runs-page-range')?.textContent;
const next = () => document.querySelector<HTMLButtonElement>('[data-runs-page=next]')!;
const previous = () => document.querySelector<HTMLButtonElement>('[data-runs-page=previous]')!;
const changeScope = (repo: string) => {
  const select = document.querySelector<HTMLSelectElement>('.repo-select')!;
  select.value = repo;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('voyage history', () => {
  it('browses beyond the recent agent feed and preserves the page during polling', async () => {
    const { view, started, requests } = setup();
    await started;
    expect(range()).toBe('1–25 of 62');
    expect(previous().disabled).toBe(true);
    next().click();
    await vi.waitFor(() => expect(range()).toBe('26–50 of 62'));
    next().click();
    await vi.waitFor(() => expect(range()).toBe('51–62 of 62'));
    expect(next().disabled).toBe(true);
    expect(document.querySelector('[data-runid=run-a-61]')).not.toBeNull();
    await view.refresh();
    expect(range()).toBe('51–62 of 62');
    expect(requests.filter(url => url.pathname === '/api/runs').at(-1)?.searchParams.get('offset')).toBe('50');
    previous().click();
    await vi.waitFor(() => expect(range()).toBe('26–50 of 62'));
  });

  it('keeps the PR draft and log drawer nodes while changing and refreshing pages', async () => {
    const { started, view } = setup(() => null, '/runs?repo=org/a&run=run-a-0');
    await started;
    const draft = document.querySelector<HTMLInputElement>('.pr-lookup-input')!;
    const drawer = document.querySelector('.run-drawer-body');
    const tab = document.querySelector('.run-tab.is-active');
    draft.value = 'org/b#34';
    next().click();
    await vi.waitFor(() => expect(range()).toBe('26–50 of 62'));
    await view.refresh();
    expect(document.querySelector('.pr-lookup-input')).toBe(draft);
    expect(draft.value).toBe('org/b#34');
    expect(document.querySelector('.run-drawer-body')).toBe(drawer);
    expect(document.querySelector('.run-tab.is-active')).toBe(tab);
  });

  it('opens a selected log without waiting for a slow history response', async () => {
    const pending = deferred<Response>();
    let request: URL | undefined;
    const { started } = setup(url => {
      if (url.pathname === '/api/runs') { request = url; return pending.promise; }
      return null;
    }, '/runs?repo=org/a&run=run-a-0');
    await vi.waitFor(() => expect(document.querySelector('.run-tab.is-active')?.getAttribute('data-tabid')).toBe('run-a-0'));
    expect(range()).toBe('Loading…');
    pending.resolve(page(request!));
    await started;
    expect(range()).toBe('1–25 of 62');
  });

  it('resets scope to page one and ignores an old in-flight page', async () => {
    const pending = deferred<Response>();
    let oldUrl: URL | undefined;
    const { started } = setup(url => {
      if (url.pathname === '/api/runs' && url.searchParams.get('repo') === 'org/a' && url.searchParams.get('offset') === '25') {
        oldUrl = url;
        return pending.promise;
      }
      return null;
    });
    await started;
    next().click();
    expect(range()).toBe('Loading…');
    changeScope('org/b');
    await vi.waitFor(() => expect(range()).toBe('1–1 of 1'));
    pending.resolve(page(oldUrl!));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(range()).toBe('1–1 of 1');
    expect(document.querySelector('[data-runid=run-b-0]')).not.toBeNull();
    expect(document.querySelector('[data-runid=run-a-25]')).toBeNull();
  });

  it('does not accept a stale response after leaving and returning to the same scope', async () => {
    const pending = deferred<Response>();
    let oldUrl: URL | undefined;
    let deferPage = true;
    const { started } = setup(url => {
      if (url.pathname === '/api/runs' && url.searchParams.get('repo') === 'org/a' && url.searchParams.get('offset') === '25' && deferPage) {
        oldUrl = url;
        return pending.promise;
      }
      return null;
    });
    await started;
    next().click();
    changeScope('org/b');
    await vi.waitFor(() => expect(range()).toBe('1–1 of 1'));
    deferPage = false;
    changeScope('org/a');
    await vi.waitFor(() => expect(range()).toBe('1–25 of 62'));
    pending.resolve(page(oldUrl!));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(range()).toBe('1–25 of 62');
  });

  it('shows a retryable page error without replacing a draft', async () => {
    let failing = true;
    const { started } = setup(url => url.pathname === '/api/runs' && url.searchParams.get('offset') === '25' && failing ? json({ error: 'History temporarily unavailable.' }, 503) : null);
    await started;
    const draft = document.querySelector<HTMLInputElement>('.pr-lookup-input')!;
    draft.value = 'org/a#19';
    next().click();
    await vi.waitFor(() => expect(document.querySelector('[data-runs-retry]')).not.toBeNull());
    expect(document.querySelector('[data-pane=recent] [role=alert]')?.textContent).toContain('History temporarily unavailable.');
    expect(previous().disabled).toBe(true);
    failing = false;
    document.querySelector<HTMLButtonElement>('[data-runs-retry]')!.click();
    await vi.waitFor(() => expect(range()).toBe('26–50 of 62'));
    expect(draft.value).toBe('org/a#19');
  });

  it('clamps to the last available page when stored history shrinks', async () => {
    let rows = items;
    const { started, view } = setup(url => url.pathname === '/api/runs' ? page(url, rows) : null);
    await started;
    next().click();
    await vi.waitFor(() => expect(range()).toBe('26–50 of 62'));
    next().click();
    await vi.waitFor(() => expect(range()).toBe('51–62 of 62'));
    rows = items.slice(0, 27);
    await view.refresh();
    expect(range()).toBe('26–27 of 27');
    expect(next().disabled).toBe(true);
  });

  it('renders empty history independently of the recent agent feed', async () => {
    const { started } = setup(url => url.pathname === '/api/runs' ? page(url, []) : null);
    await started;
    expect(range()).toBe('0 of 0');
    expect(document.querySelector('[data-pane=recent] [data-runid]')).toBeNull();
    expect(next().disabled).toBe(true);
    expect(previous().disabled).toBe(true);
  });
});
