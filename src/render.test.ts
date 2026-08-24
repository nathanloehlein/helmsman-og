import { beforeEach, describe, expect, it } from 'vitest';
import { renderDashboard } from './render';
import type { DashboardSnapshot } from './data/mock';
import type { RunSummary } from './data/agents';
import type { UiConfig } from './data/config';

const NOW: Date = new Date('2026-08-17T12:00:00.000Z');

function snapshot(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    repo: 'o/r',
    queue: [],
    steps: [],
    shipped: [],
    activity: [],
    stats: { completedToday: 0, awaitingReview: 0, avgCycleMinutes: 0 },
    throughput7d: [0, 0, 0, 0, 0, 0, 0],
    ...over,
  };
}

function root(): HTMLDivElement {
  document.body.innerHTML = '<div id="app"></div>';
  const el: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!el) throw new Error('missing #app');
  return el;
}

describe('renderDashboard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not throw and renders markup on the idle path (steps: [])', () => {
    const el: HTMLDivElement = root();
    expect(() => renderDashboard(el, snapshot({ steps: [] }), NOW)).not.toThrow();
    expect(el.innerHTML.length).toBeGreaterThan(0);
    expect(el.innerHTML).toContain('BACKLOG RUNNER');
  });

  it('shows the degraded banner when sources are degraded', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, ['jira', 'github']);
    expect(el.querySelector('.degraded-banner')).not.toBeNull();
  });

  it('omits the degraded banner when no sources are degraded', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, []);
    expect(el.querySelector('.degraded-banner')).toBeNull();
  });

  it('renders the repo options from the provided list and marks the selected one', () => {
    const el: HTMLDivElement = root();
    const scoped: DashboardSnapshot = snapshot({
      repo: 'alpha',
      shipped: [
        { number: 1, title: 'a', ticketId: '—', status: 'in-review', openedAt: NOW.toISOString(), repo: 'org/alpha' },
        { number: 3, title: 'c', ticketId: '—', status: 'in-review', openedAt: NOW.toISOString(), repo: 'org/alpha' },
      ],
    });

    renderDashboard(el, scoped, NOW, [], ['org/alpha', 'org/beta'], 'org/alpha');
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.repo-select');
    expect(select).not.toBeNull();
    expect(el.querySelector('.topbar .repo-select')).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['', 'org/alpha', 'org/beta']);
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('org/alpha');
    expect(el.querySelectorAll('.pr-card').length).toBe(2);
  });

  it('escapes untrusted ticket titles to prevent XSS', () => {
    const el: HTMLDivElement = root();
    const payload: string = '<img src=x onerror=alert(1)>';
    const malicious: DashboardSnapshot = snapshot({
      queue: [{ id: 'X-1', title: payload, priority: 'P1', status: 'in-progress', repo: 'o/r' }],
    });
    renderDashboard(el, malicious, NOW);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.queue-title')?.textContent).toBe(payload);
    expect(el.innerHTML).toContain('&lt;img');
  });

  it('renders an agent-row for each running run and skips non-running ones', () => {
    const el: HTMLDivElement = root();
    const runs: RunSummary[] = [
      {
        id: 'run-1',
        ticketId: 'ABC-1',
        repo: 'org/alpha',
        status: 'running',
        attempt: 1,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: null,
      },
      {
        id: 'run-2',
        ticketId: 'ABC-2',
        repo: 'org/beta',
        status: 'running',
        attempt: 2,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: 1.23,
      },
      {
        id: 'run-3',
        ticketId: 'ABC-3',
        repo: 'org/gamma',
        status: 'succeeded',
        attempt: 1,
        prNumber: 4,
        startedAt: NOW.toISOString(),
        costUsd: 0.5,
      },
    ];

    renderDashboard(el, snapshot(), NOW, [], [], null, runs);

    const rows: NodeListOf<HTMLLIElement> = el.querySelectorAll<HTMLLIElement>('.agent-row');
    expect(rows.length).toBe(2);
    rows.forEach((rowEl) => {
      expect(rowEl.dataset.runid).toBeTruthy();
      expect(rowEl.querySelector('.agent-stop')).not.toBeNull();
    });
    const agentListHtml: string = el.querySelector('.agent-list')!.innerHTML;
    expect(agentListHtml).toContain('ABC-1');
    expect(agentListHtml).toContain('ABC-2');
    expect(agentListHtml).not.toContain('ABC-3');
  });

  it('shows the empty note when no agents are running', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], [], null, []);
    const emptyNote: Element | null = el.querySelector('.agent-list .empty-note');
    expect(emptyNote).not.toBeNull();
    expect(emptyNote?.textContent).toContain('No agents running.');
  });

  it('shows the attempt against maxAttempts when caps are provided', () => {
    const el: HTMLDivElement = root();
    const runs: RunSummary[] = [
      {
        id: 'run-1',
        ticketId: 'ABC-1',
        repo: 'org/alpha',
        status: 'running',
        attempt: 2,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: null,
      },
    ];
    renderDashboard(el, snapshot(), NOW, [], [], null, runs, [], { maxAttempts: 3, maxCostUsd: null });
    expect(el.innerHTML).toContain('2/3');
  });

  it('shows the cost against maxCostUsd when caps are provided', () => {
    const el: HTMLDivElement = root();
    const runs: RunSummary[] = [
      {
        id: 'run-1',
        ticketId: 'ABC-1',
        repo: 'org/alpha',
        status: 'running',
        attempt: 1,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: 1.25,
      },
    ];
    renderDashboard(el, snapshot(), NOW, [], [], null, runs, [], { maxAttempts: 3, maxCostUsd: 5 });
    expect(el.innerHTML).toContain('1.25');
    expect(el.innerHTML).toContain('5');
  });

  it('renders the auto-claim toggle checked when the selected repo is in the auto-claim list', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], ['org/alpha'], 'org/alpha', [], ['org/alpha']);
    const toggle: HTMLInputElement | null = el.querySelector<HTMLInputElement>('.auto-claim-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(true);
  });

  it('renders the auto-claim toggle unchecked when the selected repo is not in the auto-claim list', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], ['org/alpha'], 'org/alpha', [], []);
    const toggle: HTMLInputElement | null = el.querySelector<HTMLInputElement>('.auto-claim-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(false);
  });

  it('omits the auto-claim toggle when no repo is selected', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], ['org/alpha'], null, [], ['org/alpha']);
    expect(el.querySelector('.auto-claim-toggle')).toBeNull();
  });

  it('renders both new-run mode controls and a launch button', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], ['org/alpha', 'org/beta'], null);

    const modeInputs: NodeListOf<HTMLInputElement> = el.querySelectorAll<HTMLInputElement>('.newrun-mode');
    expect(modeInputs.length).toBeGreaterThanOrEqual(2);
    expect(el.querySelector('.newrun-ticket')).not.toBeNull();
    expect(el.querySelector('.newrun-task')).not.toBeNull();
    const repoSelect: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.newrun-repo');
    expect(repoSelect).not.toBeNull();
    expect(Array.from(repoSelect!.options).map((o) => o.value)).toEqual(
      expect.arrayContaining(['org/alpha', 'org/beta']),
    );
    expect(el.querySelector('.newrun-launch')).not.toBeNull();
  });

  it('renders recent-run rows for terminal runs, excludes running ones, and links the PR', () => {
    const el: HTMLDivElement = root();
    const runs: RunSummary[] = [
      {
        id: 'run-1',
        ticketId: 'ABC-1',
        repo: 'org/alpha',
        status: 'running',
        attempt: 1,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: null,
      },
      {
        id: 'run-2',
        ticketId: 'ABC-2',
        repo: 'org/beta',
        status: 'succeeded',
        attempt: 1,
        prNumber: 42,
        startedAt: NOW.toISOString(),
        costUsd: 1.5,
      },
      {
        id: 'run-3',
        ticketId: 'ABC-3',
        repo: 'org/gamma',
        status: 'failed',
        attempt: 2,
        prNumber: null,
        startedAt: NOW.toISOString(),
        costUsd: 0.3,
      },
    ];

    renderDashboard(el, snapshot(), NOW, [], [], null, runs);

    const rows: NodeListOf<HTMLLIElement> = el.querySelectorAll<HTMLLIElement>('.recent-run');
    expect(rows.length).toBe(2);
    const recentRunsHtml: string = el.querySelector('.recent-runs-list')!.innerHTML;
    expect(recentRunsHtml).not.toContain('ABC-1');
    const link: HTMLAnchorElement | null = el.querySelector<HTMLAnchorElement>('a[href="https://github.com/org/beta/pull/42"]');
    expect(link).not.toBeNull();
  });

  it('shows the empty note in the recent-runs panel when there are none', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], [], null, []);
    const emptyNote: Element | null = el.querySelector('.recent-runs-list .empty-note');
    expect(emptyNote).not.toBeNull();
  });

  it('renders a config row per key, marks overridden keys, and never renders a secret', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = {
      config: { agentAdapter: 'claude-code', maxAttempts: 1 },
      overridden: ['maxAttempts'],
    };

    renderDashboard(el, snapshot(), NOW, [], [], null, [], [], { maxAttempts: 1, maxCostUsd: null }, uiConfig);

    const rows: NodeListOf<HTMLElement> = el.querySelectorAll<HTMLElement>('.config-row');
    expect(rows.length).toBe(2);
    const adapterRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="agentAdapter"]');
    expect(adapterRow).not.toBeNull();
    expect(adapterRow!.querySelector<HTMLInputElement>('.config-input')?.value).toBe('claude-code');
    const attemptsRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="maxAttempts"]');
    expect(attemptsRow).not.toBeNull();
    expect(attemptsRow!.textContent).toContain('overridden');
    expect(adapterRow!.textContent).not.toContain('overridden');
    expect(el.querySelector('.config-row[data-key="JIRA_API_TOKEN"]')).toBeNull();
    expect(el.innerHTML).not.toContain('JIRA_API_TOKEN');
  });
});
