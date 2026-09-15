import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_HELP, renderBugsView, renderCmuxView, renderDashboard, renderPrPanel, renderRunsDrawer, renderTriageView } from './render';
import { EDITABLE_KEYS } from '../server/orchestrator/config-store';
import type { CmuxViewState, RunTabView } from './render';
import type { DashboardSnapshot } from './data/mock';
import type { RunSummary } from './data/agents';
import type { UiConfig } from './data/config';
import type { PrStatusView } from './data/pr';
import type { CmuxTabView } from './logic/cmuxPanel';
import type { BugsResponse } from './types';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';
import { defaultLayout, stackOnto } from './logic/rack';

const NOW: Date = new Date('2026-08-17T12:00:00.000Z');

function snapshot(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    repo: 'o/r',
    queue: [],
    steps: [],
    shipped: [],
    myOpenPrs: [],
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
    expect(el.innerHTML).toContain('GoMaestro');
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

  it('links ticket IDs to Jira when a base URL is provided', () => {
    const el: HTMLDivElement = root();
    const snap: DashboardSnapshot = snapshot({
      queue: [{ id: 'ABC-12', title: 'thing', priority: 'P1', status: 'in-progress', repo: 'o/r' }],
      activity: [{ time: NOW.toISOString(), text: '<b>ABC-12</b> &rarr; In Review', accent: true }],
    });
    renderDashboard(el, snap, NOW, [], [], null, [], [], undefined, undefined, DEFAULT_THEME_ID, undefined, 'https://jira.example.com/');
    const links: NodeListOf<HTMLAnchorElement> = el.querySelectorAll<HTMLAnchorElement>('a.ticket-link');
    expect(links.length).toBeGreaterThanOrEqual(2);
    links.forEach((a) => expect(a.getAttribute('href')).toBe('https://jira.example.com/browse/ABC-12'));
  });

  it('leaves ticket IDs as plain text when no Jira base URL is set', () => {
    const el: HTMLDivElement = root();
    const snap: DashboardSnapshot = snapshot({
      queue: [{ id: 'ABC-12', title: 'thing', priority: 'P1', status: 'in-progress', repo: 'o/r' }],
    });
    renderDashboard(el, snap, NOW, [], [], null, [], [], undefined, undefined, DEFAULT_THEME_ID, undefined, null);
    expect(el.querySelector('a.ticket-link')).toBeNull();
    expect(el.querySelector('.queue-item .ticket-id')?.textContent).toContain('ABC-12');
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
    expect(el.querySelector('.bench-head .repo-select')).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['', 'org/alpha', 'org/beta']);
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('org/alpha');
    expect(el.querySelectorAll('.pr-card').length).toBe(2);
  });

  it('renders a theme-select with an option per theme and marks the current one selected', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], [], null, [], [], undefined, undefined, 'dracula');
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.theme-select');
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('dracula');
  });

  it('defaults the theme-select to the default theme id when no themeId is passed', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    const select: HTMLSelectElement | null = el.querySelector<HTMLSelectElement>('.theme-select');
    expect(select!.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe(DEFAULT_THEME_ID);
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

  it('scopes running and recent runs to the selected repo', () => {
    const el: HTMLDivElement = root();
    const mk = (id: string, ticketId: string, repo: string, status: string): RunSummary => ({
      id, ticketId, repo, status, attempt: 1, prNumber: null, startedAt: NOW.toISOString(), costUsd: null,
    });
    const runs: RunSummary[] = [
      mk('r1', 'ALPHA-1', 'org/alpha', 'running'),
      mk('r2', 'BETA-2', 'org/beta', 'running'),
      mk('r3', 'ALPHA-3', 'org/alpha', 'succeeded'),
      mk('r4', 'BETA-4', 'org/beta', 'succeeded'),
    ];

    renderDashboard(el, snapshot(), NOW, [], ['org/alpha', 'org/beta'], 'org/alpha', runs);

    expect(el.querySelectorAll('.agent-row').length).toBe(1);
    expect(el.querySelectorAll('.recent-run').length).toBe(1);
    const html: string = el.innerHTML;
    expect(html).toContain('ALPHA-1');
    expect(html).toContain('ALPHA-3');
    expect(html).not.toContain('BETA-2');
    expect(html).not.toContain('BETA-4');
  });

  it('renders a footer with attribution, version, updated date, and live stats', () => {
    const el: HTMLDivElement = root();
    const running: RunSummary = {
      id: 'r1', ticketId: 'A-1', repo: 'org/alpha', status: 'running',
      attempt: 1, prNumber: null, startedAt: NOW.toISOString(), costUsd: null,
    };
    renderDashboard(el, snapshot(), NOW, [], ['org/alpha', 'org/beta'], null, [running]);
    const footer: HTMLElement = el.querySelector<HTMLElement>('.app-footer')!;
    expect(footer).not.toBeNull();
    const text: string = footer.textContent ?? '';
    expect(text).toContain('nloehlein@godaddy.com');
    expect(text).toContain(`GoMaestro v${__APP_VERSION__}`);
    expect(text).toContain(`updated ${__BUILD_DATE__}`);
    expect(text).toContain('2 repos tracked');
    expect(text).toContain('1 running');
  });

  it('adds a help tooltip to each config key', () => {
    const el: HTMLDivElement = root();
    const uiConfig: UiConfig = { config: { AGENT_ADAPTER: 'claude-code' }, overridden: [] };
    renderDashboard(el, snapshot(), NOW, [], [], null, [], [], undefined, uiConfig);
    const hint: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"] .config-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('title')).toContain('claude-code');
    expect(hint?.getAttribute('aria-label')).toBe(hint?.getAttribute('title'));
  });

  it('has help text with an example for every editable config key', () => {
    for (const key of EDITABLE_KEYS) {
      expect(CONFIG_HELP[key]?.length ?? 0, `missing tooltip for ${key}`).toBeGreaterThan(0);
      expect(CONFIG_HELP[key] ?? '', `missing example for ${key}`).toContain('Example:');
    }
  });

  it('lists repo options alphabetically by short name', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW, [], ['org/zeta', 'org/alpha', 'other/beta'], null);
    const labels: string[] = Array.from(el.querySelectorAll<HTMLOptionElement>('.repo-select option'))
      .map((o) => o.textContent ?? '');
    expect(labels).toEqual(['All repos', 'alpha', 'beta', 'zeta']);
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
      config: { AGENT_ADAPTER: 'claude-code', AGENT_MAX_ATTEMPTS: 1 },
      overridden: ['AGENT_MAX_ATTEMPTS'],
    };

    renderDashboard(el, snapshot(), NOW, [], [], null, [], [], { maxAttempts: 1, maxCostUsd: null }, uiConfig);

    const rows: NodeListOf<HTMLElement> = el.querySelectorAll<HTMLElement>('.config-row');
    expect(rows.length).toBe(2);
    const adapterRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_ADAPTER"]');
    expect(adapterRow).not.toBeNull();
    expect(adapterRow!.querySelector<HTMLInputElement>('.config-input')?.value).toBe('claude-code');
    const attemptsRow: HTMLElement | null = el.querySelector<HTMLElement>('.config-row[data-key="AGENT_MAX_ATTEMPTS"]');
    expect(attemptsRow).not.toBeNull();
    expect(attemptsRow!.textContent).toContain('overridden');
    expect(adapterRow!.textContent).not.toContain('overridden');
    expect(el.querySelector('.config-row[data-key="JIRA_API_TOKEN"]')).toBeNull();
    expect(el.innerHTML).not.toContain('JIRA_API_TOKEN');
  });

  it('renders a PR lookup panel for reviewing any PR', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    expect(el.querySelector('.pr-lookup-input')).not.toBeNull();
    expect(el.querySelector('.pr-lookup-go')).not.toBeNull();
    expect(el.querySelector('.pr-lookup-result')).not.toBeNull();
  });
});

describe('renderTriageView', () => {
  const groups = {
    unassignedBacklog: [{ id: 'AB-1', title: 'Backlog one', priority: 'P1' as const, status: 'backlog' as const, repo: 'o/a' }],
    unassignedTodo: [{ id: 'AB-2', title: 'Todo one', priority: 'P2' as const, status: 'backlog' as const, repo: 'o/a' }],
    mineOpen: [{ id: 'AB-3', title: 'Mine one', priority: 'P3' as const, status: 'in-review' as const, repo: 'o/a' }],
  };

  function mount(html: string): HTMLElement {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  it('renders three groups with a back button and scope select', () => {
    const el = mount(renderTriageView(groups, { repos: ['o/a', 'o/b'], selectedRepo: 'o/a', jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID }));
    expect(el.querySelector('.view-toggle[data-view="dashboard"]')).not.toBeNull();
    expect(el.querySelectorAll('.triage-group')).toHaveLength(3);
    expect(el.querySelector('.bench-head .repo-select')).not.toBeNull();
    expect(el.textContent).toContain('AB-1');
    expect(el.textContent).toContain('AB-2');
    expect(el.textContent).toContain('AB-3');
  });

  it('puts a Launch button on unassigned rows only when a repo is scoped, never on mine rows', () => {
    const el = mount(renderTriageView(groups, { repos: ['o/a'], selectedRepo: 'o/a', jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID }));
    const launchTickets: string[] = Array.from(el.querySelectorAll<HTMLButtonElement>('.launch-btn')).map((b) => b.dataset.ticket ?? '');
    expect(launchTickets).toContain('AB-1');
    expect(launchTickets).toContain('AB-2');
    expect(launchTickets).not.toContain('AB-3');
  });

  it('hides Launch and shows a scope hint when no repo is scoped', () => {
    const el = mount(renderTriageView(groups, { repos: ['o/a'], selectedRepo: null, jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID }));
    expect(el.querySelectorAll('.launch-btn')).toHaveLength(0);
    expect(el.querySelector('.triage-hint')).not.toBeNull();
    expect(el.textContent).toContain('AB-1');
  });

  it('links ticket ids to Jira when a base url is present', () => {
    const el = mount(renderTriageView(groups, { repos: [], selectedRepo: null, jiraBaseUrl: 'https://x.atlassian.net', degraded: false, themeId: DEFAULT_THEME_ID }));
    const link: HTMLAnchorElement | null = el.querySelector<HTMLAnchorElement>('a.ticket-link[href$="/browse/AB-3"]');
    expect(link).not.toBeNull();
  });

  it('shows empty-state notes for empty groups', () => {
    const el = mount(renderTriageView(
      { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] },
      { repos: [], selectedRepo: null, jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID },
    ));
    expect(el.querySelectorAll('.empty-note').length).toBeGreaterThanOrEqual(3);
  });

  it('gives every group a collapse button carrying its id', () => {
    const el = mount(renderTriageView(groups, { repos: ['o/a'], selectedRepo: 'o/a', jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID }));
    const ids: string[] = Array.from(el.querySelectorAll<HTMLButtonElement>('.surface-collapse')).map((b) => b.dataset.collapseId ?? '');
    expect(ids).toEqual(['triage:backlog', 'triage:todo', 'triage:mine']);
  });

  it('marks a group collapsed and hides its list when its id is in the set', () => {
    const el = mount(renderTriageView(groups, { repos: ['o/a'], selectedRepo: 'o/a', jiraBaseUrl: null, degraded: false, themeId: DEFAULT_THEME_ID, collapsed: new Set(['triage:todo']) }));
    const collapsedGroups = el.querySelectorAll('.triage-group.is-collapsed');
    expect(collapsedGroups).toHaveLength(1);
    expect(collapsedGroups[0]!.querySelector('.surface-collapse')!.getAttribute('aria-expanded')).toBe('false');
  });
});

function prFixture(over: Partial<PrStatusView> = {}): PrStatusView {
  return {
    number: 42,
    repo: 'org/alpha',
    state: 'open',
    draft: false,
    merged: false,
    headRefName: 'feature-branch',
    reviewDecision: 'REVIEW_REQUIRED',
    comments: 3,
    checks: { passed: 2, failed: 0, pending: 1 },
    url: 'https://github.com/org/alpha/pull/42',
    ...over,
  };
}

describe('renderPrPanel', () => {
  it('renders the state chip, CI summary, review controls, and PR link for an open PR', () => {
    const html: string = renderPrPanel(prFixture(), false);
    expect(html).toContain('Open');
    expect(html).toContain('2');
    expect(html).toContain('pr-approve');
    expect(html).toContain('pr-request-changes');
    expect(html).toContain('pr-comment');
    expect(html).toContain('pr-review-body');
    expect(html).toContain('https://github.com/org/alpha/pull/42');
    expect(html).toContain('#42');
  });

  it('omits the rerun control when canRerun is false', () => {
    const html: string = renderPrPanel(prFixture(), false);
    expect(html).not.toContain('pr-rerun-feedback');
    expect(html).not.toContain('class="pr-rerun"');
    expect(html).not.toContain('pr-review-agent');
  });

  it('includes the rerun control when canRerun is true', () => {
    const html: string = renderPrPanel(prFixture(), true);
    expect(html).toContain('pr-rerun-feedback');
    expect(html).toContain('pr-rerun');
  });

  it('includes the code-review-with-agent button when canRerun is true', () => {
    const html: string = renderPrPanel(prFixture(), true);
    expect(html).toContain('pr-review-agent');
    expect(html).toContain('Code-review with agent');
  });

  it('includes model + effort selectors on the review/rerun controls', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderPrPanel(prFixture(), true);
    expect(el.querySelector('.pr-model')).not.toBeNull();
    expect(el.querySelector('.pr-effort')).not.toBeNull();
    expect(Array.from(el.querySelectorAll<HTMLOptionElement>('.pr-effort option')).map((o) => o.value))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('renders the reviewer tally counts', () => {
    const html: string = renderPrPanel(
      prFixture({ reviews: { requested: 2, approved: 3, changesRequested: 1, commented: 4 } }),
      false,
    );
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = html;
    const reviewers: HTMLElement | null = el.querySelector<HTMLElement>('.pr-reviewers');
    expect(reviewers).not.toBeNull();
    expect(reviewers?.textContent).toContain('2');
    expect(reviewers?.textContent).toContain('3');
    expect(reviewers?.textContent).toContain('1');
    expect(reviewers?.textContent).toContain('4');
  });

  it('renders zero reviewer counts when the tally is absent', () => {
    const html: string = renderPrPanel(prFixture({ reviews: undefined }), false);
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = html;
    expect(el.querySelector('.pr-reviewers')).not.toBeNull();
  });

  it('renders a not-found note when there is no PR', () => {
    const html: string = renderPrPanel(null, false);
    expect(html).toContain('empty-note');
    expect(html.toLowerCase()).toContain('no pr');
  });

  it('escapes a malicious headRefName and url', () => {
    const payload: string = '<img src=x onerror=alert(1)>';
    const html: string = renderPrPanel(prFixture({ headRefName: payload, url: payload }), false);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

function cmuxTabFixture(over: Partial<CmuxTabView> = {}): CmuxTabView {
  return {
    windowRef: 'win-1',
    workspaceRef: 'ws-1',
    workspaceTitle: 'orchestrator',
    surfaceRef: 'surface-1',
    surfaceTitle: 'main',
    type: 'shell',
    cwd: '/repo',
    selected: false,
    ...over,
  };
}

function cmuxStateFixture(over: Partial<CmuxViewState> = {}): CmuxViewState {
  return {
    connected: true,
    tabs: [cmuxTabFixture()],
    selectedSurface: null,
    screen: '',
    isCapturing: false,
    repos: [],
    selectedRepo: null,
    themeId: DEFAULT_THEME_ID,
    ...over,
  };
}

describe('renderCmuxView', () => {
  it('renders a not-connected note and no tab list when disconnected', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ connected: false, tabs: [cmuxTabFixture()] }));
    expect(html.toLowerCase()).toContain('not connected');
    expect(html).not.toContain('cmux-tab"');
  });

  it('renders the tab list with title and workspace/type meta', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('data-surface="surface-1"');
    expect(html).toContain('main');
    expect(html).toContain('orchestrator');
    expect(html).toContain('shell');
  });

  it('marks the selected tab and shows a prompt to select one when nothing is selected', () => {
    const html: string = renderCmuxView(cmuxStateFixture());
    expect(html).toContain('Select a tab');
    expect(html).not.toContain('is-selected');
  });

  it('shows the screen, send form, and only universal actions for a non-agent tab when selected', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({ selectedSurface: 'surface-1', screen: 'hello world' }),
    );
    expect(html).toContain('is-selected');
    expect(html).toContain('cmux-screen');
    expect(html).toContain('hello world');
    expect(html).toContain('cmux-send');
    expect(html).toContain('data-action="enter"');
    expect(html).toContain('data-action="escape"');
    expect(html).toContain('data-action="interrupt"');
    expect(html).not.toContain('data-action="continue"');
    expect(html).not.toContain('data-action="stop"');
    expect(html).not.toContain('data-action="approve"');
  });

  it('adds agent actions when the selected tab is an agent-session', () => {
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceRef: 'agent-1', type: 'agent-session' })],
        selectedSurface: 'agent-1',
        screen: '',
      }),
    );
    expect(html).toContain('data-action="continue"');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('data-action="approve"');
  });

  it('escapes malicious tab titles and screen content', () => {
    const payload: string = '<img src=x onerror=alert(1)>';
    const html: string = renderCmuxView(
      cmuxStateFixture({
        tabs: [cmuxTabFixture({ surfaceTitle: payload })],
        selectedSurface: 'surface-1',
        screen: payload,
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders a no-tabs note when the tab list is empty', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ tabs: [] }));
    expect(html.toLowerCase()).toContain('no cmux tabs');
  });

  it('gives the list and detail panels collapse buttons with stable ids', () => {
    const html: string = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1' }));
    expect(html).toContain('data-collapse-id="cmux:list"');
    expect(html).toContain('data-collapse-id="cmux:detail"');
  });

  it('marks a cmux panel collapsed when its id is in the set', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderCmuxView(cmuxStateFixture({ selectedSurface: 'surface-1', collapsed: new Set(['cmux:list']) }));
    expect(el.querySelector('.cmux-list.is-collapsed')).not.toBeNull();
    expect(el.querySelector('.cmux-detail.is-collapsed')).toBeNull();
  });
});

describe('renderRunsDrawer', () => {
  const tab = (over: Partial<RunTabView> = {}): RunTabView => ({
    id: 'run-1',
    label: 'TICK-1 — thing',
    complete: false,
    ...over,
  });

  it('renders a tab per run with select and close controls', () => {
    const html: string = renderRunsDrawer([tab({ id: 'a', label: 'A' }), tab({ id: 'b', label: 'B' })], 'a');
    expect(html).toContain('data-tabid="a"');
    expect(html).toContain('data-tabid="b"');
    expect((html.match(/run-tab-close/g) ?? []).length).toBe(2);
    expect((html.match(/run-tab-select/g) ?? []).length).toBe(2);
  });

  it('marks the active tab', () => {
    const html: string = renderRunsDrawer([tab({ id: 'a' }), tab({ id: 'b' })], 'b');
    const bTab: string = html.slice(html.indexOf('data-tabid="b"') - 40, html.indexOf('data-tabid="b"'));
    expect(bTab).toContain('is-active');
  });

  it('flags completed tabs', () => {
    const html: string = renderRunsDrawer([tab({ complete: true })], 'run-1');
    expect(html).toContain('run-tab-dot is-complete');
  });

  it('provides body, footer, and pr shells', () => {
    const html: string = renderRunsDrawer([tab()], 'run-1');
    expect(html).toContain('run-drawer-body');
    expect(html).toContain('run-drawer-footer');
    expect(html).toContain('run-drawer-pr');
  });

  it('escapes malicious labels', () => {
    const html: string = renderRunsDrawer([tab({ label: '<img src=x onerror=alert(1)>' })], 'run-1');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows an empty-state placeholder when there are no tabs', () => {
    const html: string = renderRunsDrawer([], null);
    expect(html).toContain('run-drawer-empty');
    expect(html).toContain('run-drawer-title');
    expect(html).not.toContain('run-tab-close');
  });

  it('shows a drawer collapse button when tabs exist, none when empty', () => {
    expect(renderRunsDrawer([tab()], 'run-1')).toContain('data-collapse-id="runs:drawer"');
    expect(renderRunsDrawer([], null)).not.toContain('data-collapse-id="runs:drawer"');
  });

  it('reflects collapsed state on the drawer button', () => {
    const el: HTMLElement = document.createElement('div');
    el.innerHTML = renderRunsDrawer([tab()], 'run-1', true);
    expect(el.querySelector('.surface-collapse')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('renderDashboard bench rack', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a runs-drawer slot, the bench nameplate, and four page tabs', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    expect(el.querySelector('.runs-drawer-slot')).not.toBeNull();
    expect(el.querySelector('.bench-head .nameplate')).not.toBeNull();
    expect(el.querySelectorAll('.page-tab')).toHaveLength(4);
    expect(el.querySelector('.page-tab.is-active')?.getAttribute('data-view')).toBe('dashboard');
  });

  it('renders every panel as a draggable faceplate with a collapse control', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    const panels: string[] = Array.from(el.querySelectorAll<HTMLElement>('.faceplate')).map((f) => f.dataset.panel ?? '');
    ['newrun', 'backlog', 'running', 'recent', 'pr', 'shipped', 'activity', 'config'].forEach((id) =>
      expect(panels).toContain(id),
    );
    expect(el.querySelector('.rack-handle[draggable="true"]')).not.toBeNull();
    expect(el.querySelector('.panel-collapse')).not.toBeNull();
  });

  it('renders model + effort selectors in the New run panel', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    expect(el.querySelector('.newrun-model')).not.toBeNull();
    expect(el.querySelector('.newrun-effort')).not.toBeNull();
  });

  it('defaults the New Run tuning selects to astra and medium', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    const model = el.querySelector<HTMLSelectElement>('.newrun-model')!;
    const effort = el.querySelector<HTMLSelectElement>('.newrun-effort')!;
    expect(model.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('gpt-6-astra');
    expect(effort.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('medium');
  });

  it('renders the My open PRs panel with clickable rows carrying repo + number', () => {
    const el: HTMLDivElement = root();
    const snap = snapshot({
      myOpenPrs: [
        { number: 42, title: 'do a thing', repo: 'org/alpha', reviewDecision: 'CHANGES_REQUESTED', draft: false, createdAt: NOW.toISOString() },
        { number: 43, title: 'wip thing', repo: 'org/alpha', reviewDecision: 'REVIEW_REQUIRED', draft: true, createdAt: NOW.toISOString() },
      ],
    });
    renderDashboard(el, snap, NOW);
    expect(el.querySelector('.faceplate[data-panel="myprs"]')).not.toBeNull();
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.myprs-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.repo).toBe('org/alpha');
    expect(rows[0].dataset.number).toBe('42');
    expect(el.textContent).toContain('#42');
    expect(el.textContent).toContain('Draft');
  });

  it('shows an empty note in My open PRs when there are none', () => {
    const el: HTMLDivElement = root();
    renderDashboard(el, snapshot(), NOW);
    const panel = el.querySelector<HTMLElement>('.faceplate[data-panel="myprs"]');
    expect(panel?.querySelector('.empty-note')).not.toBeNull();
  });

  it('honors a custom layout: stacked panels share a slot with tabs', () => {
    const el: HTMLDivElement = root();
    const layout = stackOnto(defaultLayout(), 'running', 'backlog');
    renderDashboard(el, snapshot(), NOW, [], [], null, [], [], undefined, undefined, DEFAULT_THEME_ID, layout);
    const tabbed = el.querySelector<HTMLElement>('.faceplate .slot-tabs');
    expect(tabbed).not.toBeNull();
    const tabPanels = Array.from(tabbed!.querySelectorAll<HTMLButtonElement>('.slot-tab')).map((b) => b.dataset.panelTab);
    expect(tabPanels).toContain('backlog');
    expect(tabPanels).toContain('running');
  });
});

describe('renderBugsView', () => {
  function mount(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }
  const res: BugsResponse = {
    cards: [{
      project: 'AIROBUILD', repo: 'o/a', label: 'Airo Editing',
      open: 20, delta: 4, completed: 6, pastSla: 7,
      oldest: { key: 'AIROBUILD-2992', ageDays: 82 },
      p75: { days: 9.4, n: 94, capped: false },
      rows: [
        { key: 'AIROBUILD-5849', title: 'Media Library bug', priority: 'P1 - High', severity: 'S2 - Medium', sla: { text: 'Past SLA by 7d', overdue: true, days: -7 } },
        { key: 'AIROBUILD-6319', title: 'Media preview stale', priority: 'P1 - High', severity: 'S2 - Medium', sla: { text: 'SLA in 6d', overdue: false, days: 6 } },
      ],
      degraded: false, jiraBaseUrl: 'https://x.atlassian.net',
    }],
    degraded: false, generatedAt: '2026-09-15T16:15:05Z', latestWindow: '2026-09-09 → 2026-09-15', previousWindow: '2026-09-02 → 2026-09-08',
  };
  const opts = { repos: ['o/a'], selectedRepo: 'o/a', themeId: DEFAULT_THEME_ID };

  it('renders a BUGS tab, a card header, stats, and a row per bug', () => {
    const el = mount(renderBugsView(res, opts));
    expect(el.querySelector('.page-tab[data-view="bugs"]')).not.toBeNull();
    expect(el.textContent).toContain('20 Open bugs');
    expect(el.textContent).toContain('+4');
    expect(el.textContent).toContain('9.4');
    expect(el.querySelectorAll('.bug-row')).toHaveLength(2);
    expect(el.querySelector('a.ticket-link[href$="/browse/AIROBUILD-2992"]')).not.toBeNull();
  });

  it('flags overdue SLA with chip-blocked and future SLA without it', () => {
    const el = mount(renderBugsView(res, opts));
    const slas = Array.from(el.querySelectorAll<HTMLElement>('.bug-sla'));
    expect(slas[0]!.className).toContain('chip-blocked');
    expect(slas[1]!.className).not.toContain('chip-blocked');
  });

  it('shows a degraded banner and no cards when degraded', () => {
    const el = mount(renderBugsView({ ...res, cards: [], degraded: true }, opts));
    expect(el.querySelector('.degraded-banner')).not.toBeNull();
    expect(el.querySelectorAll('.bug-card')).toHaveLength(0);
  });

  it('escapes malicious titles', () => {
    const bad: BugsResponse = { ...res, cards: [{ ...res.cards[0]!, rows: [{ ...res.cards[0]!.rows[0]!, title: '<img src=x onerror=alert(1)>' }] }] };
    const html = renderBugsView(bad, opts);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows an empty-state note (not a blank grid) when the scope has no cards and is not degraded', () => {
    const el = mount(renderBugsView({ ...res, cards: [], degraded: false }, opts));
    expect(el.querySelector('.empty-note')?.textContent).toBe('No bug data for this scope.');
    expect(el.querySelector('.degraded-banner')).toBeNull();
    expect(el.querySelectorAll('.bug-card')).toHaveLength(0);
  });

  it('formats generatedAt as a readable UTC string', () => {
    const el = mount(renderBugsView(res, opts));
    expect(el.textContent).toContain('Generated 2026-09-15 16:15 UTC');
  });

  it('shows an em dash when generatedAt is empty', () => {
    const el = mount(renderBugsView({ ...res, generatedAt: '' }, opts));
    expect(el.textContent).toContain('Generated —');
  });

  it('falls back to the raw value when generatedAt is malformed', () => {
    const el = mount(renderBugsView({ ...res, generatedAt: 'not-a-date' }, opts));
    expect(el.textContent).toContain('Generated not-a-date');
  });
});
