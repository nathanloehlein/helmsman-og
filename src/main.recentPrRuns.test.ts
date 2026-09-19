import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import { LOCAL_POLL_MS } from './data/live';
import type { RunSummary } from './data/agents';

const json = (value: unknown) => new Response(JSON.stringify(value));
let view: DashboardView | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  window.history.replaceState(null, '', '/prs?repo=org/a&pr=42');
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-17T21:00:00Z');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('recent PR voyages local refresh', () => {
  it('updates results on the existing local poll, preserves PR drafts and diff state, and opens an existing voyage', async () => {
    const snapshot = await loadDashboard();
    const runs: RunSummary[] = [{
      id: 'review-a', ticketId: 'PR review', repo: 'org/a', status: 'running', attempt: 1,
      prNumber: 42, startedAt: '2026-09-17T20:00:00Z', costUsd: null,
    }];
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      requests.push(url.pathname);
      if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: 'org/a', jiraBaseUrl: null });
      if (url.pathname === '/api/agents') return json({ runs, autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
      if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
      if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
      if (url.pathname === '/api/pr/open' || url.pathname === '/api/pr/review-requests') return json({ prs: [], degraded: false, truncated: false });
      if (url.pathname === '/api/pr') return json({ number: 42, repo: 'org/a', state: 'open', draft: false, merged: false, headRefName: 'topic', reviewDecision: 'REVIEW_REQUIRED', comments: 0, checks: { passed: 0, failed: 0, pending: 0 }, url: 'https://github.com/org/a/pull/42' });
      if (url.pathname === '/api/pr/diff') return json({ files: [{ filename: 'app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+change' }] });
      return new Response(null, { status: 404 });
    }));
    const root = document.querySelector<HTMLElement>('#app')!;
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    const lookup = root.querySelector<HTMLInputElement>('.pr-lookup-input')!;
    const review = root.querySelector<HTMLTextAreaElement>('.pr-review-body')!;
    const diff = root.querySelector<HTMLDetailsElement>('.diff-file')!;
    lookup.value = 'org/a#99';
    review.value = 'Unsent review draft';
    diff.open = true;
    const initialCalls = requests.length;
    const initialAgentsCalls = requests.filter(path => path === '/api/agents').length;
    runs[0]!.status = 'succeeded';
    runs[0]!.reviewOutcome = 'APPROVE';
    runs.push({ ...runs[0]!, id: 'review-b', startedAt: '2026-09-17T20:30:00Z', reviewOutcome: 'COMMENT' });
    await vi.advanceTimersByTimeAsync(LOCAL_POLL_MS);
    expect(requests.slice(initialCalls).sort()).toEqual(['/api/agents', '/api/context', '/api/slack']);
    expect(requests.filter(path => path === '/api/agents')).toHaveLength(initialAgentsCalls + 1);
    expect(root.querySelectorAll('.pr-recent-runs .recent-run')).toHaveLength(2);
    expect(root.querySelector('.pr-recent-runs [data-runid="review-a"] .voyage-result')?.getAttribute('aria-label')).toBe('Inspection recommendation: Approve');
    expect(root.querySelector('.pr-lookup-input')).toBe(lookup);
    expect(lookup.value).toBe('org/a#99');
    expect(root.querySelector('.pr-review-body')).toBe(review);
    expect(review.value).toBe('Unsent review draft');
    expect(root.querySelector('.diff-file')).toBe(diff);
    expect(diff.open).toBe(true);
    root.querySelector<HTMLAnchorElement>('.pr-recent-runs [data-runid="review-a"] .app-link')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.pathname).toBe('/runs');
    expect(new URLSearchParams(window.location.search).get('run')).toBe('review-a');
    expect(root.querySelector('.run-tab[data-tabid="review-a"]')).not.toBeNull();
    expect(requests).not.toContain('/api/agents/launch');
  });
});
