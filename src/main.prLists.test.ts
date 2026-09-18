import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard as loadMockSnapshot } from './data/mock';
import type { OpenPr } from './types';

const originalFetch = globalThis.fetch;
const pr = (repo: string, number: number): OpenPr => ({ repo, number, title: `Change ${number}`, reviewDecision: '', draft: false, createdAt: '2026-09-16T12:00:00Z' });
const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const list = (prs: OpenPr[]) => ({ prs, degraded: false, truncated: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(extra: (url: URL) => Promise<Response> | Response | null) {
  const snapshot = await loadMockSnapshot();
  snapshot.myOpenPrs = [pr('org/other', 99)];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const custom = extra(url);
    if (custom) return custom;
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json(list([]));
    if (url.pathname === '/api/pr/diff') return json({ files: [] });
    if (url.pathname === '/api/pr') return json({ number: Number(url.searchParams.get('number')), repo: url.searchParams.get('repo'), state: 'open', draft: false, merged: false, headRefName: 'topic', reviewDecision: 'REVIEW_REQUIRED', comments: 0, checks: { passed: 0, failed: 0, pending: 0 }, url: 'https://github.com/org/a/pull/11' });
    throw new Error(`Unexpected request ${url}`);
  });
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  await view.refresh();
  return { root, view };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('PR list navigation and refresh', () => {
  it('keeps personal lists on PR, deduplicates slow requests, preserves lookup input, and opens rows by keyboard', async () => {
    const requested = deferred<Response>();
    let requests = 0;
    const { root, view } = await setup((url) => {
      if (url.pathname !== '/api/pr/review-requests') return null;
      expect(url.searchParams.has('repo')).toBe(false);
      requests++;
      return requested.promise;
    });
    expect(root.querySelector('.pr-authored')).toBeNull();
    expect(root.querySelector('[data-panel="repoprs"]')?.textContent).toContain('Select a repository');
    root.querySelector<HTMLButtonElement>('[data-view="prs"]')!.click();
    const lookup = root.querySelector<HTMLInputElement>('.pr-lookup-input')!;
    lookup.value = 'Keep my draft input';
    const refresh = view.refresh();
    await vi.waitFor(() => expect(requests).toBe(1));
    requested.resolve(json(list([pr('org/a', 11)])));
    await refresh;
    await vi.waitFor(() => expect(root.querySelectorAll('.pr-review-requests .pr-list-row')).toHaveLength(1));
    expect(requests).toBe(1);
    expect(root.querySelector('.pr-lookup-input')).toBe(lookup);
    expect(lookup.value).toBe('Keep my draft input');
    expect(root.querySelector('.pr-authored')?.textContent).toContain('org/other');
    root.querySelector<HTMLElement>('.pr-review-requests .pr-list-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('11'));
    const comment = root.querySelector<HTMLTextAreaElement>('.pr-review-body')!;
    comment.value = 'Keep this unsent review';
    await view.refresh();
    expect(root.querySelector('.pr-review-body')).toBe(comment);
    expect(comment.value).toBe('Keep this unsent review');
  });

  it('ignores stale repository responses and preserves the new-voyage form when a list finishes', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const requested: string[] = [];
    const { root, view } = await setup((url) => {
      if (url.pathname !== '/api/pr/open') return null;
      const repo = url.searchParams.get('repo')!;
      requested.push(repo);
      return repo === 'org/a' ? a.promise : b.promise;
    });
    const choose = (repo: string) => {
      const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
      select.value = repo;
      select.dispatchEvent(new Event('change'));
    };
    choose('org/a');
    await vi.waitFor(() => expect(requested).toContain('org/a'));
    const refreshA = view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested.filter((repo) => repo === 'org/a')).toHaveLength(1);
    choose('org/b');
    await vi.waitFor(() => expect(requested).toContain('org/b'));
    const task = root.querySelector<HTMLTextAreaElement>('.newrun-task')!;
    task.value = 'Do not discard this task';
    b.resolve(json(list([pr('org/b', 202)])));
    await vi.waitFor(() => expect(root.querySelector('.pr-list-row')?.getAttribute('data-number')).toBe('202'));
    a.resolve(json(list([pr('org/a', 101)])));
    await refreshA;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('.pr-list-row')?.getAttribute('data-number')).toBe('202');
    expect(root.querySelector('.pr-list-row')?.getAttribute('data-repo')).toBe('org/b');
    expect(root.querySelector('.newrun-task')).toBe(task);
    expect(task.value).toBe('Do not discard this task');
    expect(root.querySelector('.pr-authored')).toBeNull();
  });
  it('keeps the last PR selected when an earlier detail request finishes late', async () => {
    const first = deferred<Response>();
    const { root } = await setup((url) => {
      if (url.pathname === '/api/pr/review-requests') return json(list([pr('org/a', 11), pr('org/b', 12)]));
      if (url.pathname === '/api/pr' && url.searchParams.get('number') === '11') return first.promise;
      return null;
    });
    root.querySelector<HTMLButtonElement>('[data-view="prs"]')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.pr-review-requests .pr-list-row')).toHaveLength(2));
    root.querySelector<HTMLElement>('.pr-review-requests [data-number="11"]')!.click();
    root.querySelector<HTMLElement>('.pr-review-requests [data-number="12"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('12'));
    first.resolve(json({ number: 11, repo: 'org/a', checks: { passed: 0, failed: 0, pending: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('.pr-lookup-result .pr-panel')?.getAttribute('data-pr-number')).toBe('12');
  });

});
