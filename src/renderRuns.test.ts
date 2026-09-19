import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPirateMode } from './logic/terminology';
import type { RunSummary } from './data/agents';
import { DEFAULT_THEME_ID } from './data/themes';
import type { PrViewState } from './render';
import { renderRunHistory, renderRunsView, type RunHistoryState } from './renderRuns';

const state: PrViewState = { repo: null, number: null, pr: null, diff: null, loading: false };
const opts = { repos: ['org/alpha'], selectedRepo: null, themeId: DEFAULT_THEME_ID, runs: [] as RunSummary[] };

function mount(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { id: 'run-1', ticketId: 'review', repo: 'org/alpha', status: 'running', attempt: 1,
    prNumber: 42, startedAt: '2026-09-17T15:00:00.000Z', costUsd: null, ...overrides };
}

beforeEach(() => setPirateMode(true));
afterEach(() => localStorage.removeItem('helmsman.pirateMode'));

describe('renderRunsView', () => {
  it.each([true, false])('uses the selected terminology for the run page controls (%s)', pirate => {
    setPirateMode(pirate);
    const el = mount(renderRunsView(state, opts));
    expect(el.querySelector('[data-pane=newrun] .panel-title')?.textContent).toBe(pirate ? 'Review or update a bounty' : 'Review or update a PR');
    expect(el.querySelector('[data-pane=recent] .panel-title')?.textContent).toBe(pirate ? 'All voyages' : 'All runs');
    expect(el.querySelector('.pr-lookup-go')?.textContent).toBe(pirate ? 'Load Bounty' : 'Load PR');
    expect(el.querySelector('label[for="runs-pr-lookup"]')?.textContent).toBe(pirate ? 'Bounty URL or owner/repo#number' : 'PR URL or owner/repo#number');
    expect(el.querySelector('[data-pane=recent] .empty-note')?.textContent).toBe(pirate ? 'No past voyages.' : 'No past runs.');
    expect(el.querySelector('[data-pane=newrun] .app-link')?.getAttribute('href')).toBe('/runs?pane=newrun');
  });

  it.each([
    ['APPROVE', 'Approve', 'approved'],
    ['REQUEST_CHANGES', 'Request changes', 'changes'],
    ['COMMENT', 'Comment only', 'commented'],
  ] as const)('shows the saved %s recommendation independently of voyage success', (reviewOutcome, label, tone) => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ status: 'succeeded', reviewOutcome })] }));
    const icon = el.querySelector('.voyage-result');
    expect(icon?.getAttribute('aria-label')).toBe(`Inspection recommendation: ${label}`);
    expect(icon?.classList.contains(`voyage-result-${tone}`)).toBe(true);
    expect(icon?.querySelector('svg')).not.toBeNull();
    expect(icon?.getAttribute('title')).toContain('Published as a GitHub comment');
    expect(el.querySelector('.recent-run .chip')).toBeNull();
  });

  it.each(['running', 'queued', 'failed', 'stopped'])('does not show a final review recommendation on %s voyages', (status) => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ status, reviewOutcome: 'APPROVE' })] }));
    expect(el.querySelector('.voyage-result-approved')).toBeNull();
    if (status === 'failed' || status === 'stopped') {
      expect(el.querySelector('.voyage-result')?.getAttribute('aria-label')).toBe(status === 'failed' ? 'Voyage marooned' : 'Voyage stopped');
    } else expect(el.querySelector('.voyage-result')?.getAttribute('aria-label')).toBe(status === 'running' ? 'Voyage underway' : 'Voyage queued');
    expect(el.querySelector('.chip')).toBeNull();
  });

  it.each([undefined, 'constructor', '<img src=x onerror=alert(1)>'])('does not invent a review result when the saved outcome is %j', (reviewOutcome) => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ status: 'succeeded', reviewOutcome } as Partial<RunSummary>)] }));
    expect(el.querySelector('.voyage-result')?.getAttribute('aria-label')).toContain('No inspection recommendation recorded');
    expect(el.querySelector('.voyage-result-approved, img')).toBeNull();
  });

  it('distinguishes a request-changes recommendation from a failed voyage', () => {
    const el = mount(renderRunsView(state, { ...opts, runs: [
      run({ id: 'changes', status: 'succeeded', reviewOutcome: 'REQUEST_CHANGES' }),
      run({ id: 'failed', status: 'failed' }),
    ] }));
    const changes = el.querySelector('[data-runid="changes"]');
    const failed = el.querySelector('[data-runid="failed"]');
    expect(changes?.querySelector('.voyage-result-changes')?.getAttribute('aria-label')).toBe('Inspection recommendation: Request changes');
    expect(changes?.querySelector('.voyage-result-failed, [data-retry-run-id]')).toBeNull();
    expect(failed?.querySelector('.voyage-result-failed')?.getAttribute('aria-label')).toBe('Voyage marooned');
    expect(failed?.querySelector('.voyage-result-changes')).toBeNull();
  });

  it('places retry beside the task identity and keeps ID copy and timestamp on the right', () => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ status: 'failed' })] }));
    const row = el.querySelector('.recent-run');
    expect(row?.querySelector('.voyage-identity .ticket-id')?.textContent).toBe('Bounty #42');
    expect(row?.querySelector('.runs-voyage-link .agent-repo')?.textContent).toBe('alpha');
    expect(row?.querySelector('.runs-voyage-link time, .runs-voyage-link button')).toBeNull();
    const meta = row?.querySelector('.voyage-row-meta');
    const retry = row?.querySelector('.voyage-row-main > [data-retry-run-id]');
    expect(retry?.previousElementSibling?.classList.contains('runs-voyage-link')).toBe(true);
    expect(retry?.getAttribute('data-retry-run-id')).toBe('run-1');
    expect(retry?.querySelector('.sr-only')?.textContent).toBe('Retry');
    expect(meta?.querySelector('[data-retry-run-id]')).toBeNull();
    const controls = [...(meta?.querySelectorAll('time, [data-copy-run-id]') ?? [])];
    expect(controls).toHaveLength(2);
    expect(controls[0]?.getAttribute('data-copy-run-id')).toBe('run-1');
    expect(controls[1]?.getAttribute('datetime')).toBe('2026-09-17T15:00:00.000Z');
    expect(controls[1]?.getAttribute('title')).toBeTruthy();
    expect(meta?.lastElementChild).toBe(controls[1]);
  });

  it.each([
    ['review', 42, 'Bounty #42'],
    ['review', null, 'review'],
    ['review', -1, 'review'],
    ['ABC-123', 42, 'ABC-123 · Bounty #42'],
  ])('uses a meaningful title for %s with PR %s', (ticketId, prNumber, title) => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ ticketId, prNumber })] }));
    expect(el.querySelector('.voyage-identity .ticket-id')?.textContent).toBe(title);
  });

  it('escapes saved verdict text in tooltips', () => {
    const reviewVerdict = '\"><img src=x onerror=alert(1)>';
    const el = mount(renderRunsView(state, { ...opts, runs: [run({ status: 'succeeded', reviewOutcome: 'COMMENT', reviewVerdict })] }));
    expect(el.querySelector('.voyage-result')?.getAttribute('title')).toContain(reviewVerdict);
    expect(el.querySelector('img')).toBeNull();
  });

  it('offers a PR lookup and linkable panes without launch controls before loading a PR', () => {
    const el = mount(renderRunsView(state, opts));
    expect(el.querySelector('[data-page="runs"]')).not.toBeNull();
    expect(el.querySelector('.page-tab.is-active')?.getAttribute('data-view')).toBe('runs');
    expect(el.querySelector('.pr-lookup-input')).not.toBeNull();
    expect(el.querySelector('[data-pane="newrun"] .app-link')?.getAttribute('href')).toBe('/runs?pane=newrun');
    expect(el.querySelector('[data-pane="recent"] .app-link')?.getAttribute('href')).toBe('/runs?pane=recent');
    expect(el.querySelector('.runs-drawer-slot')?.getAttribute('data-pane')).toBe('tasks');
    expect(el.querySelector('.pr-review-agent')).toBeNull();
  });

  it('preloads PR actions and includes the PR in its shareable pane URL', () => {
    const pr = { repo: 'org/alpha', number: 42, state: 'open', draft: false, merged: false,
      isOwnPr: true, headRefName: 'feature', reviewDecision: 'REVIEW_REQUIRED', comments: 0,
      checks: { passed: 0, pending: 0, failed: 0 }, url: 'https://github.com/org/alpha/pull/42' };
    const el = mount(renderRunsView({ ...state, repo: pr.repo, number: pr.number, pr }, opts));
    expect(el.querySelector<HTMLInputElement>('.pr-lookup-input')?.value).toBe('org/alpha#42');
    expect(el.querySelector('.pr-review-agent')).not.toBeNull();
    expect(el.querySelector('.pr-rerun')).not.toBeNull();
    const link = el.querySelector('[data-pane="newrun"] .app-link')?.getAttribute('href');
    const params = new URL(link ?? '', 'https://helmsman.test').searchParams;
    expect(params.get('repo')).toBeNull();
    expect(params.get('prRepo')).toBe('org/alpha');
    expect(params.get('pr')).toBe('42');
  });

  it('lists active and finished voyages newest first with direct links', () => {
    const el = mount(renderRunsView(state, { ...opts, runs: [
      run({ id: 'finished', status: 'succeeded' }),
      run({ id: 'active', startedAt: '2026-09-17T16:00:00.000Z' }),
    ] }));
    const rows = [...el.querySelectorAll('.recent-run')];
    expect(rows.map((row) => row.getAttribute('data-runid'))).toEqual(['active', 'finished']);
    expect(rows[0]?.querySelector('.voyage-result')?.getAttribute('aria-label')).toBe('Voyage underway');
    expect(rows[1]?.querySelector('.voyage-result')?.getAttribute('aria-label')).toContain('Shipshape');
    expect(el.querySelector('.recent-run .chip')).toBeNull();
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/runs?run=active');
  });

  it('scopes voyages to the chosen repo while tolerating malformed rows and dates', () => {
    const el = mount(renderRunsView(state, { ...opts, selectedRepo: 'org/alpha', runs: [
      null as unknown as RunSummary, run({ startedAt: 'invalid' }), run({ id: 'other', repo: 'org/beta' }),
    ] }));
    expect(el.querySelectorAll('.recent-run')).toHaveLength(1);
    expect(el.querySelector('time')).toBeNull();
    const voyageUrl = new URL(el.querySelector('.recent-run .runs-voyage-link')?.getAttribute('href') ?? '', 'https://helmsman.test');
    expect(voyageUrl.pathname).toBe('/runs');
    expect(voyageUrl.searchParams.get('run')).toBe('run-1');
    expect(voyageUrl.searchParams.get('repo')).toBe('org/alpha');
    expect(el.querySelector('[data-pane="recent"] .app-link')?.getAttribute('href')).toBe('/runs?repo=org%2Falpha&pane=recent');
  });

  it('escapes text and excludes invalid run identifiers from links', () => {
    const el = mount(renderRunsView(state, { ...opts, runs: [run({
      id: 'a&pane=newrun', ticketId: '<img src=x onerror=alert(1)>', status: '<script>alert(1)</script>',
    })] }));
    expect(el.querySelector('img, script')).toBeNull();
    expect(el.querySelector('.recent-run a')?.getAttribute('href')).toBe('/runs');
    expect(el.querySelector('.voyage-identity')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('renderRunHistory', () => {
  const history: RunHistoryState = { total: 60, limit: 25, offset: 25, loading: false, error: null };

  it('shows the full count and middle-page range with previous and next actions', () => {
    const runs = Array.from({ length: 25 }, (_, index) => run({ id: `run-${index}` }));
    const el = mount(renderRunHistory(runs, 'org/alpha', history));
    expect(el.querySelector('.panel-count')?.textContent).toBe('60');
    expect(el.querySelector('.runs-page-range')?.textContent).toBe('26–50 of 60');
    expect(el.querySelectorAll('button:disabled')).toHaveLength(0);
    expect(el.querySelector('.runs-pagination')?.getAttribute('tabindex')).toBe('-1');
    expect(el.querySelector('[data-pane=recent]')?.getAttribute('aria-busy')).toBe('false');
  });

  it('disables previous on the first page and next on the last page', () => {
    const first = mount(renderRunHistory([run()], null, { ...history, offset: 0 }));
    expect(first.querySelector<HTMLButtonElement>('[data-runs-page=previous]')?.disabled).toBe(true);
    expect(first.querySelector<HTMLButtonElement>('[data-runs-page=next]')?.disabled).toBe(false);
    const last = mount(renderRunHistory([run()], null, { ...history, total: 26 }));
    expect(last.querySelector('.runs-page-range')?.textContent).toBe('26–26 of 26');
    expect(last.querySelector<HTMLButtonElement>('[data-runs-page=previous]')?.disabled).toBe(false);
    expect(last.querySelector<HTMLButtonElement>('[data-runs-page=next]')?.disabled).toBe(true);
  });

  it('announces loading, disables pagination, and keeps existing rows during refresh', () => {
    const el = mount(renderRunHistory([run()], null, { ...history, loading: true }));
    expect(el.querySelector('[data-pane=recent]')?.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.runs-page-range[role=status]')?.textContent).toBe('Loading…');
    expect(el.querySelectorAll('.recent-run')).toHaveLength(1);
    expect(el.querySelectorAll('button:disabled')).toHaveLength(2);
    const initial = mount(renderRunHistory([], null, { ...history, loading: true }));
    expect(initial.querySelector('.empty-note')?.textContent).toBe('Loading voyages…');
  });

  it('shows a retryable escaped error without presenting stale rows or an empty-state claim', () => {
    const el = mount(renderRunHistory([run()], null, { ...history, error: '<img src=x> unavailable' }));
    expect(el.querySelector('[role=alert]')?.textContent).toContain('<img src=x> unavailable');
    expect(el.querySelector('img, .recent-run')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-runs-retry]')?.disabled).toBe(false);
    expect(el.querySelectorAll('[data-runs-page]:disabled')).toHaveLength(2);
    expect(el.querySelector('.runs-page-range')?.textContent).toBe('History unavailable');
  });

  it('shows a successful empty history with both controls disabled', () => {
    const el = mount(renderRunHistory([], null, { ...history, total: 0, offset: 0 }));
    expect(el.querySelector('.empty-note')?.textContent).toBe('No past voyages.');
    expect(el.querySelector('.runs-page-range')?.textContent).toBe('0 of 0');
    expect(el.querySelectorAll('button:disabled')).toHaveLength(2);
    expect(el.querySelector('[data-runs-retry]')).toBeNull();
  });
});
