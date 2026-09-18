import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { RunSummary } from './data/agents';

const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const views: DashboardView[] = [];
const streams: RunStream[] = [];

class RunStream {
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    streams.push(this);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const status = (repo: string, number: number) => ({
  number, repo, isOwnPr: true, state: 'open', draft: false, merged: false, headRefName: 'topic',
  reviewDecision: 'REVIEW_REQUIRED', comments: 0, checks: { passed: 0, failed: 0, pending: 0 },
  url: `https://github.com/${repo}/pull/${number}`,
});

async function setup(path: string, extra: (url: URL) => Response | Promise<Response> | null = () => null, runs: RunSummary[] = []) {
  window.history.replaceState(null, '', path);
  const snapshot = await loadMockSnapshot();
  const requests: { url: URL; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (method !== 'GET') throw new Error(`Unexpected write ${method} ${url}`);
    const custom = extra(url);
    if (custom) return custom;
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname.startsWith('/api/agents/')) return new Response(null, { status: 404 });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/pr') return json(status(url.searchParams.get('repo') ?? '', Number(url.searchParams.get('number'))));
    throw new Error(`Unexpected request ${url}`);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  return { root, view, requests };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  streams.length = 0;
  vi.stubGlobal('EventSource', RunStream);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('URL navigation', () => {
  it.each([
    ['/prs', 'org/a'], ['/runs', 'org/a'], ['/prs', null], ['/runs', null],
  ] as const)('retains header scope %s %j after a panel override and reload', async (path, selectedRepo) => {
    const initial = await setup(`${path}${selectedRepo ? `?repo=${encodeURIComponent(selectedRepo)}` : ''}`);
    const input = initial.root.querySelector<HTMLInputElement>('.pr-lookup-input');
    expect(input).not.toBeNull();
    input!.value = 'org/b#42';
    initial.root.querySelector<HTMLButtonElement>('.pr-lookup-go')?.click();
    await vi.waitFor(() => expect(initial.root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-repo')).toBe('org/b'));
    expect(initial.root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe(selectedRepo ?? '');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('repo')).toBe(selectedRepo);
    expect(url.searchParams.get('prRepo')).toBe('org/b');
    expect(url.searchParams.get('pr')).toBe('42');

    initial.view.destroy();
    document.body.innerHTML = '<div id="app"></div>';
    const reloaded = await setup(url.pathname + url.search);
    expect(reloaded.root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe(selectedRepo ?? '');
    expect(reloaded.root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-repo')).toBe('org/b');
    expect(reloaded.root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('42');
    expect(reloaded.requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('opens a directly linked PR and its diff with matching repository scope', async () => {
    const { root, requests } = await setup('/prs?repo=org/a&pr=11&pane=diff');
    expect(root.querySelector('[data-page="prs"]')).not.toBeNull();
    expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('11');
    expect(root.querySelector<HTMLInputElement>('.pr-lookup-input')?.value).toBe('org/a#11');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/a');
    for (const pathname of ['/api/pr', '/api/pr/diff']) {
      expect(requests.some(({ url }) => url.pathname === pathname && url.searchParams.get('repo') === 'org/a' && url.searchParams.get('number') === '11')).toBe(true);
    }
    expect(document.title).toBe('PR · Helmsman');
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('shows a directly linked galleon in the selector even before discovery includes it', async () => {
    const { root } = await setup('/prs?repo=org/external&pr=11');
    expect(root.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/external');
    expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-repo')).toBe('org/external');
  });

  it.each(['review', 'rerun'])('prefills the %s action without launching a voyage', async (mode) => {
    const { root, requests } = await setup(`/runs?repo=org/a&pr=11&mode=${mode}`);
    expect(root.querySelector('[data-page="runs"]')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.pr-lookup-input')?.value).toBe('org/a#11');
    expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('11');
    expect(document.activeElement).toBe(root.querySelector(mode === 'review' ? '.pr-review-agent' : '.pr-rerun-feedback'));
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(streams).toHaveLength(0);
  });

  it('does not expose relaunch for another author through a relaunch URL', async () => {
    const { root, requests } = await setup('/runs?repo=org/a&pr=11&mode=rerun', url =>
      url.pathname === '/api/pr' ? json({ ...status('org/a', 11), isOwnPr: false }) : null);
    expect(root.querySelector('.pr-rerun')).toBeNull();
    expect(root.querySelector('.pr-rerun-feedback')).toBeNull();
    expect(root.querySelector('.pr-review-agent')).not.toBeNull();
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('restores the page and PR through browser Back and Forward', async () => {
    const { root } = await setup('/prs?repo=org/a&pr=11');
    root.querySelector<HTMLAnchorElement>('[data-view="runs"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-page="runs"]')).not.toBeNull());
    expect(window.location.pathname).toBe('/runs');
    window.history.back();
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/prs');
      expect(root.querySelector('[data-page="prs"]')).not.toBeNull();
      expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('11');
    });
    window.history.forward();
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/runs');
      expect(root.querySelector('[data-page="runs"]')).not.toBeNull();
    });
  });

  it('refreshes local Git data without replacing unsaved config and ignores an older repo response', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const { root, requests } = await setup('/config', (url) => {
      if (url.pathname === '/api/config') return json({ config: { MAX_ATTEMPTS: '1' }, overridden: [] });
      if (url.pathname === '/api/repo/local') return url.searchParams.get('repo') === 'org/a' ? first.promise : second.promise;
      return null;
    });
    const choose = (repo: string) => {
      const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
      select.value = repo;
      select.dispatchEvent(new Event('change'));
    };
    choose('org/a');
    await vi.waitFor(() => expect(requests.some(({ url }) => url.pathname === '/api/repo/local' && url.searchParams.get('repo') === 'org/a')).toBe(true));
    choose('org/b');
    await vi.waitFor(() => expect(requests.some(({ url }) => url.pathname === '/api/repo/local' && url.searchParams.get('repo') === 'org/b')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = root.querySelector<HTMLInputElement>('input.config-input')!;
    input.value = 'unsaved';
    const payload = (repo: string, name: string) => ({ repo, path: `/repos/${repo}`, branches: [{ name, current: true, upstream: null, commit: 'abcdef' }], worktrees: [], error: null });
    second.resolve(json(payload('org/b', 'branch-b')));
    await vi.waitFor(() => expect(root.querySelector('.local-git-panel')?.textContent).toContain('branch-b'));
    first.resolve(json(payload('org/a', 'branch-a')));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('.local-git-panel')?.textContent).not.toContain('branch-a');
    expect(root.querySelector('input.config-input')).toBe(input);
    expect(input.value).toBe('unsaved');
  });

  it('drops malformed parameters before making PR requests or opening streams', async () => {
    const { root, requests } = await setup('/runs?repo=../private&pr=-1&run=../../secret&pane=%22%5D&mode=launch');
    expect(root.querySelector('[data-page="runs"]')).not.toBeNull();
    expect(window.location.pathname + window.location.search).toBe('/runs');
    expect(requests.some(({ url }) => ['/api/pr', '/api/pr/diff', '/api/agents/launch'].includes(url.pathname))).toBe(false);
    expect(requests.every(({ url, method }) => !url.searchParams.has('repo') && method === 'GET')).toBe(true);
    expect(streams).toHaveLength(0);
  });

  it('opens an existing voyage log directly and closes its stream on destroy', async () => {
    const run: RunSummary = { id: 'run-123', ticketId: 'TASK-1', repo: 'org/a', status: 'running', attempt: 1, prNumber: null, startedAt: '2026-09-17T16:00:00Z', costUsd: null };
    const { root, view } = await setup('/runs?run=run-123&pane=tasks', () => null, [run]);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toBe('/api/agents/run-123/log');
    streams[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: 1, runId: 'run-123', ts: '2026-09-17T16:00:01Z', kind: 'text', text: 'Inspecting changes' }) }));
    await vi.waitFor(() => expect(root.querySelector('.run-drawer-body')?.textContent).toContain('Inspecting changes'));
    expect(root.querySelector('.run-tab.is-active')?.getAttribute('data-tabid')).toBe('run-123');
    view.destroy();
    expect(streams[0]?.close).toHaveBeenCalled();
  });

  it('keeps the readable verdict directly above success when the drawer repaints', async () => {
    const run: RunSummary = { id: 'review-run', ticketId: 'review', repo: 'org/a', status: 'running', attempt: 1, prNumber: 11, startedAt: '2026-09-17T16:00:00Z', costUsd: null };
    const { root } = await setup('/runs?run=review-run', () => null, [run]);
    for (const [id, kind, text] of [
      [1, 'review-verdict', 'Verdict: Request changes — Guard <nullable> outcomes.'],
      [2, 'run-complete', 'succeeded'],
    ] as const) {
      streams[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id, runId: run.id, ts: run.startedAt, kind, text }) }));
    }
    await vi.waitFor(() => expect(root.querySelector('.run-line-review-verdict')).not.toBeNull());
    const verdict = root.querySelector('.run-line-review-verdict');
    expect(verdict?.textContent).toBe('Verdict: Request changes — Guard <nullable> outcomes.');
    expect(verdict?.nextElementSibling?.textContent).toBe('succeeded');
    expect(verdict?.nextElementSibling?.classList.contains('run-line-run-complete')).toBe(true);
    expect(verdict?.querySelector('nullable')).toBeNull();
  });

  it('coalesces drawer PR lookups and refreshes after completion even if the first lookup is pending', async () => {
    const run: RunSummary = { id: 'review-run', ticketId: 'review', repo: 'org/a', status: 'running', attempt: 1, prNumber: 11, startedAt: '2026-09-17T16:00:00Z', costUsd: null };
    const pending = deferred<Response>();
    let lookups = 0;
    const { root } = await setup('/runs?run=review-run', url => {
      if (url.pathname === '/api/pr') {
        lookups++;
        return lookups === 1 ? pending.promise : json(status('org/a', 11));
      }
      if (url.pathname === '/api/agents/review-run') return json({ ...run, status: 'succeeded' });
      return null;
    }, [run]);
    root.querySelector<HTMLButtonElement>('.run-tab-select')!.click();
    expect(lookups).toBe(1);
    streams[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: 1, runId: run.id, ts: run.startedAt, kind: 'run-complete', text: 'succeeded' }) }));
    expect(lookups).toBe(1);
    pending.resolve(json(status('org/a', 11)));
    await vi.waitFor(() => expect(lookups).toBe(2));
    root.querySelector<HTMLButtonElement>('.run-tab-select')!.click();
    await vi.waitFor(() => expect(root.querySelector('.run-drawer-pr .pr-panel')).not.toBeNull());
    expect(lookups).toBe(2);
  });

  it('retains the updated manual review status when reopening a cached voyage pane', async () => {
    const run: RunSummary = { id: 'review-run', ticketId: 'review', repo: 'org/a', status: 'running', attempt: 1, prNumber: 11, startedAt: '2026-09-17T16:00:00Z', costUsd: null };
    const { root } = await setup('/runs?run=review-run', () => null, [run]);
    await vi.waitFor(() => expect(root.querySelector('.run-drawer-pr .pr-approve')).not.toBeNull());
    const previousFetch = globalThis.fetch;
    const updated = { ...status('org/a', 11), viewerReview: 'APPROVED' };
    let statusLookups = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/pr/review') return json({ ok: true });
      if (url.pathname === '/api/pr') { statusLookups++; return json(updated); }
      return previousFetch(input, init);
    }));
    root.querySelector<HTMLButtonElement>('.run-drawer-pr .pr-approve')!.click();
    await vi.waitFor(() => expect(root.querySelector('.run-drawer-pr .pr-viewer-review')?.textContent).toContain('Approved'));
    root.querySelector<HTMLButtonElement>('.run-tab-select')!.click();
    await vi.waitFor(() => expect(root.querySelector('.run-drawer-pr .pr-viewer-review')?.textContent).toContain('Approved'));
    expect(statusLookups).toBe(1);
  });

  it('shows an unavailable voyage without opening a stream for an unknown run', async () => {
    const { root } = await setup('/runs?run=missing-run');
    await vi.waitFor(() => expect(root.querySelector('.run-drawer')?.textContent).toContain('This voyage was not found or the server is unavailable.'));
    expect(streams).toHaveLength(0);
  });

  it('loads an older voyage absent from the recent runs list', async () => {
    const run: RunSummary = { id: 'older-run', ticketId: 'TASK-2', repo: 'org/a', status: 'succeeded', attempt: 1, prNumber: null, startedAt: '2026-01-01T16:00:00Z', costUsd: null };
    const { root, requests } = await setup('/runs?run=older-run', (url) => url.pathname === '/api/agents/older-run' ? json(run) : null);
    expect(requests.some(({ url }) => url.pathname === '/api/agents/older-run')).toBe(true);
    expect(streams[0]?.url).toBe('/api/agents/older-run/log');
    expect(root.querySelector('.run-tab.is-active')?.textContent).toContain('TASK-2');
  });

  it('ignores a slow PR response after a newer popstate navigation', async () => {
    const first = deferred<Response>();
    const { root, requests } = await setup('/prs', (url) => url.pathname === '/api/pr' && url.searchParams.get('number') === '11' ? first.promise : null);
    window.history.pushState(null, '', '/prs?repo=org/a&pr=11');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(requests.some(({ url }) => url.pathname === '/api/pr' && url.searchParams.get('number') === '11')).toBe(true));
    window.history.pushState(null, '', '/prs?repo=org/b&pr=12');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('12'));
    first.resolve(json(status('org/a', 11)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('12');
    expect(new URL(window.location.href).searchParams.get('pr')).toBe('12');
    expect(root.querySelector<HTMLInputElement>('.pr-lookup-input')?.value).toBe('org/b#12');
  });
});
