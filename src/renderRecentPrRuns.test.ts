import { describe, expect, it } from 'vitest';
import { renderPrView, renderRecentPrRuns } from './render';
import { DEFAULT_THEME_ID } from './data/themes';
import type { RunSummary } from './data/agents';

const run = (id: string, overrides: Partial<RunSummary> = {}): RunSummary => ({
  id, ticketId: 'review', repo: 'org/a', status: 'succeeded', attempt: 1,
  prNumber: 42, startedAt: '2026-09-17T12:00:00Z', costUsd: null, ...overrides,
});
const mount = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};

describe('recent PR voyages', () => {
  it('shows the newest ten matching PR runs without changing the source order', () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`, {
      startedAt: new Date(Date.UTC(2026, 8, 17, index)).toISOString(),
    }));
    runs.push(run('other-repo', { repo: 'org/b', startedAt: '2026-09-18T00:00:00Z' }));
    for (const [index, prNumber] of [null, 0, -1, 1.5, NaN].entries()) {
      runs.push(run(`invalid-${index}`, { prNumber, startedAt: '2026-09-19T00:00:00Z' }));
    }
    const originalIds = runs.map(item => item.id);
    const element = mount(renderRecentPrRuns(runs, 'org/a'));
    expect(Array.from(element.querySelectorAll<HTMLElement>('.recent-run'), row => row.dataset.runid))
      .toEqual(Array.from({ length: 10 }, (_, index) => `run-${11 - index}`));
    expect(element.querySelector('.panel-count')?.textContent).toBe('10 of 12');
    expect(runs.map(item => item.id)).toEqual(originalIds);
  });

  it('includes underway PRs across repositories and exposes saved result icons with voyage links', () => {
    const element = mount(renderRecentPrRuns([
      run('review-a', { reviewOutcome: 'APPROVE' }),
      run('review-b', { repo: 'org/b', reviewOutcome: 'REQUEST_CHANGES' }),
      run('review-c', { reviewOutcome: 'COMMENT' }),
      run('underway', { status: 'running' }),
    ], null));
    expect(element.querySelectorAll('.recent-run')).toHaveLength(4);
    for (const [id, label] of [['review-a', 'Approve'], ['review-b', 'Request changes'], ['review-c', 'Comment only']]) {
      const row = element.querySelector(`[data-runid="${id}"]`);
      expect(row?.querySelector('.voyage-result')?.getAttribute('aria-label')).toBe(`Review recommendation: ${label}`);
      expect(row?.querySelector('.app-link')?.getAttribute('href')).toBe(`/runs?run=${id}`);
    }
    expect(element.querySelector('[data-runid="underway"] .voyage-result')?.getAttribute('aria-label')).toBe('Voyage underway');
    expect(element.querySelector('.recent-run .chip')).toBeNull();
  });

  it('renders an empty state for a repository without PR voyages', () => {
    const element = mount(renderRecentPrRuns([run('review-a')], 'org/b'));
    expect(element.querySelector('.panel-title')?.textContent).toBe('Recent PR voyages');
    expect(element.querySelector('.empty-note')?.textContent).toContain('No recent PR voyages');
    expect(element.querySelectorAll('.recent-run')).toHaveLength(0);
  });

  it('offers Retry for failed PR review voyages outside the navigation link', () => {
    const element = mount(renderRecentPrRuns([run('review-failed', { status: 'failed' }), run('review-succeeded')], null));
    expect(element.querySelectorAll('[data-retry-run-id]')).toHaveLength(1);
    expect(element.querySelector('[data-retry-run-id]')?.getAttribute('data-retry-run-id')).toBe('review-failed');
    expect(element.querySelector('[data-retry-feedback-for="review-failed"]')?.getAttribute('role')).toBe('status');
    expect(element.querySelector('a [data-retry-run-id]')).toBeNull();
  });

  it('keeps the repository scope and full source ID in voyage navigation', () => {
    const id = 'github-1234567890abcdef0123456789abcdef';
    const element = mount(renderRecentPrRuns([run(id)], 'org/a'));
    expect(element.querySelector('.voyage-id')?.textContent).toBe('github-1234567890ab');
    expect(element.querySelector('.voyage-id')?.getAttribute('title')).toBe(id);
    expect(element.querySelector('.recent-run')?.getAttribute('data-runid')).toBe(id);
    const voyageUrl = new URL(element.querySelector('.runs-voyage-link')?.getAttribute('href') ?? '', 'https://helmsman.test');
    expect(voyageUrl.pathname).toBe('/runs');
    expect(voyageUrl.searchParams.get('run')).toBe(id);
    expect(voyageUrl.searchParams.get('repo')).toBe('org/a');
  });

  it('includes recent voyages on the PR page and escapes their labels', () => {
    const element = mount(renderPrView({ repo: null, number: null, pr: null, diff: null, loading: false }, {
      repos: ['org/a'], selectedRepo: 'org/a', themeId: DEFAULT_THEME_ID,
      runs: [run('review-a', { ticketId: '<img src=x onerror=alert(1)>' })],
    }));
    expect(element.querySelector('.pr-recent-runs [data-runid="review-a"]')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(element.querySelector('.pr-recent-runs img')).toBeNull();
    expect(element.querySelector('.pr-lookup-input')).not.toBeNull();
  });
});
