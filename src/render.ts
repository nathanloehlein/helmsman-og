import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { escapeHtml as esc } from './logic/html';
import type { PrStatus, Priority } from './types';
import type { AgentCaps, RunSummary } from './data/agents';
import type { UiConfig } from './data/config';
import type { PrStatusView } from './data/pr';
import type { CmuxTabView } from './logic/cmuxPanel';
import { providerOf } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';

const PRIORITY_CLASS: Record<Priority, string> = { P1: 'pri-p1', P2: 'pri-p2', P3: 'pri-p3' };

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { label: 'In review', chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
}

const RUN_STATUS_CHIP: Record<string, { label: string; chipClass: string; laneState: string }> = {
  succeeded: { label: 'Succeeded', chipClass: 'chip-done', laneState: 'double' },
  failed: { label: 'Failed', chipClass: 'chip-blocked', laneState: 'ring' },
  stopped: { label: 'Stopped', chipClass: 'chip-progress', laneState: 'gap' },
}

const ICON_LOCK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V5.1a2.5 2.5 0 0 1 5 0V7"/></svg>'

const ICON_STOP: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2"/></svg>'

export const ICON_CLOSE: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

const DIRECTION_CONTRACT: string = `<!--
  IMPECCABLE DIRECTION CONTRACT — seed key operate/direction a04e52f5 (form: normalled jackfield, grounded #6-assignment overridden by user pick).
  THESIS: an agent fleet read as a studio patch-bay normalling schedule — every run is a numbered lane tied to its ticket/PR by one amber link line whose STROKE PATTERN, not colour, carries state. Refuses the generic dark-SaaS card grid and the sci-fi HUD glow it replaced.
  OWN-WORLD: black glass ground (#07070a), ONE signal amber (#f5a623). Condensed grotesque + tabular lane numbers 01..N. Fixed left legend strip, console lanes on the right, dark edge gutters (nothing spans full width). Rank by inversion: the focused lane knocks dark out of a solid amber plate. State = link-rail pattern: unbroken live · gap // stopped · doubled selected · open-ring ⊗ failed · faint queued. No colour carries state.
  STORY: operator scans lanes across the room, reads each run's state from its rail, and acts — launch, stop, review, re-run — without leaving the board. Merge is never here.
  FIRST VIEWPORT: left legend (brand, fleet status, repo scope, merge-gate note); right console — topbar (scope · MODE LIVE · clock), then numbered lanes for the backlog queue and running agents, rails running to ticket/PR.
  FORM: normalled jackfield (operate-b-normalled-jackfield); user-picked over assigned mission-control; seed a04e52f5.
  FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`

function formatCycle(minutes: number): string {
  if (minutes <= 0) return '—'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) {
    const hours: number = minutes / 60
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }
  return `${(minutes / 1440).toFixed(1)}d`
};

function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo
}

function laneNo(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function laneRail(state: string): string {
  return `<span class="lane-rail lane-rail--${state}" aria-hidden="true"><span class="lane-ring"></span></span>`;
}

function buildSparkline(values: number[]): string {
  const width = 220;
  const top = 8;
  const baseline = 44;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const step = width / (values.length - 1);

  const points = values.map((value, index) => {
    const x = index * step;
    const y = baseline - ((value - min) / range) * (baseline - top);
    return { x, y };
  });

  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `${line} ${width},54 0,54`;
  const last = points[points.length - 1];

  return `
    <svg viewBox="0 0 ${width} 54" width="100%" height="54" preserveAspectRatio="none"
         role="img" aria-label="Tickets shipped per day, last 7 days">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="${baseline}" x2="${width}" y2="${baseline}" stroke="var(--line)" stroke-width="1"/>
      <polygon points="${area}" fill="url(#sparkfill)"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x}" cy="${last.y}" r="3.2" fill="var(--accent)"/>
    </svg>`;
}

export function renderDashboard(
  root: HTMLElement,
  data: DashboardSnapshot,
  now: Date,
  degraded: string[] = [],
  repos: string[] = [],
  selectedRepo: string | null = null,
  runs: RunSummary[] = [],
  autoClaimRepos: string[] = [],
  caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null },
  uiConfig: UiConfig = { config: {}, overridden: [] },
  themeId: string = DEFAULT_THEME_ID,
): void {
  const queue = sortByPriority(data.queue);
  const activeRuns: RunSummary[] = runs.filter((r) => r.status === 'running');
  const terminalRuns: RunSummary[] = runs.filter((r) => r.status !== 'running');

  const repoOptions: string = ['<option value="">All repos</option>']
    .concat(
      repos.map(
        (repo) =>
          `<option value="${esc(repo)}"${repo === selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');

  const themeOptions: string = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');

  const autoClaimToggle: string = selectedRepo
    ? `<label class="auto-claim"><input type="checkbox" class="auto-claim-toggle"${autoClaimRepos.includes(selectedRepo) ? ' checked' : ''}><span>Auto-claim</span></label>`
    : '';

  const queueItems = queue.length
    ? queue
        .map(
          (ticket, i) => `
      <li class="lane queue-item">
        <span class="lane-no mono">${laneNo(i)}</span>
        <span class="ticket-id">${esc(ticket.id)}</span>
        <span class="queue-title">${esc(ticket.title)}</span>
        ${laneRail('queued')}
        <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        <button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="Launch agent for ${esc(ticket.id)}">Launch</button>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No backlog tickets assigned.</li>';

  const agentRows: string = activeRuns.length
    ? activeRuns
        .map(
          (run, i) => `
      <li class="lane agent-row" data-runid="${esc(run.id)}">
        <span class="lane-no mono">${laneNo(i)}</span>
        <span class="ticket-id">${esc(run.ticketId)}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        ${laneRail('live')}
        <span class="agent-elapsed mono">${formatRelativeTime(run.startedAt, now)}</span>
        ${caps.maxAttempts > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}/${caps.maxAttempts}</span>` : run.attempt > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}</span>` : ''}
        ${run.costUsd != null ? `<span class="agent-cost mono">$${run.costUsd.toFixed(2)}${caps.maxCostUsd != null ? `/$${caps.maxCostUsd.toFixed(2)}` : ''}</span>` : ''}
        <span class="chip chip-progress">Running</span>
        <button class="agent-stop" data-runid="${esc(run.id)}" aria-label="Stop run ${esc(run.ticketId)}">${ICON_STOP}</button>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No agents running.</li>';

  const shippedCards = data.shipped
    .map((pr) => {
      const status = PR_STATUS[pr.status];
      const repoShort: string = pr.repo ? shortRepo(pr.repo) : '';
      const subParts: string[] = [
        pr.ticketId !== '—' ? esc(pr.ticketId) : '',
        repoShort ? esc(repoShort) : '',
        `opened ${formatRelativeTime(pr.openedAt, now)}`,
      ].filter((part) => part !== '');
      return `
      <div class="pr-card">
        <span class="pr-num mono">#${pr.number}</span>
        <div class="pr-title-line">
          <span class="pr-title">${esc(pr.title)}</span>
          <span class="pr-sub">${subParts.join(' &middot; ')}</span>
        </div>
        <span class="chip ${status.chipClass}">${status.label}</span>
      </div>`;
    })
    .join('') || '<div class="empty-note">No recent pull requests.</div>';

  const activityLines = data.activity.length
    ? data.activity
        .map(
          (event) => `
      <div class="feed-line">
        <span class="feed-time mono">${formatRelativeTime(event.time, now)}</span>
        <span class="feed-text${event.accent ? ' tag-accent' : ''}">${event.text}</span>
      </div>`,
        )
        .join('')
    : '<div class="empty-note">No recent activity.</div>';

  const banner: string =
    degraded.length > 0
      ? `<div class="degraded-banner">Showing sample data for: ${degraded.join(', ')} — check server credentials.</div>`
      : '';

  const newRunRepoOptions: string = repos
    .map((repo) => `<option value="${esc(repo)}">${esc(shortRepo(repo))}</option>`)
    .join('');

  const recentRunItems: string = terminalRuns.length
    ? terminalRuns
        .map((run, i) => {
          const statusInfo = RUN_STATUS_CHIP[run.status] ?? { label: esc(run.status), chipClass: 'chip-progress', laneState: 'gap' };
          const costText: string = run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '&mdash;';
          const prLink: string =
            run.prNumber != null
              ? `<a class="recent-run-pr" href="https://github.com/${esc(run.repo)}/pull/${run.prNumber}" target="_blank" rel="noopener">#${run.prNumber}</a>`
              : '';
          return `
      <li class="lane recent-run" data-runid="${esc(run.id)}">
        <span class="lane-no mono">${laneNo(i)}</span>
        <span class="ticket-id">${esc(run.ticketId || 'freeform')}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        ${laneRail(statusInfo.laneState)}
        <span class="agent-cost mono">${costText}</span>
        ${prLink}
        <span class="chip ${statusInfo.chipClass}">${statusInfo.label}</span>
      </li>`;
        })
        .join('')
    : '<li class="empty-note">No past runs.</li>';

  const configEntries: [string, unknown][] = Object.entries(uiConfig.config ?? {});
  const configRows: string = configEntries.length
    ? configEntries
        .map(([key, value]) => {
          const isOverridden: boolean = (uiConfig.overridden ?? []).includes(key);
          return `
      <div class="config-row" data-key="${esc(key)}">
        <span class="config-key mono">${esc(key)}${isOverridden ? ' <span class="config-overridden">(overridden)</span>' : ''}</span>
        <input class="config-input" type="text" value="${esc(String(value ?? ''))}">
        <button class="config-save" data-key="${esc(key)}">Save</button>
        <span class="config-error" role="alert"></span>
      </div>`;
        })
        .join('')
    : '<div class="empty-note">No configuration keys.</div>';

  root.innerHTML = `${DIRECTION_CONTRACT}
    <div class="deck">
      <aside class="legend">
        <div class="legend-brand">
          <span class="brand-mark mono">BR</span>
          <span class="brand">BACKLOG RUNNER</span>
          <span class="brand-sub mono">AGENT JACKFIELD</span>
        </div>

        <div class="legend-block">
          <div class="legend-head mono">FLEET STATUS</div>
          <div class="legend-stat"><span class="legend-stat-label">Running</span><span class="legend-stat-val mono">${activeRuns.length}</span></div>
          <div class="legend-stat"><span class="legend-stat-label">Queued</span><span class="legend-stat-val mono">${queue.length}</span></div>
          <div class="legend-stat"><span class="legend-stat-label">Awaiting review</span><span class="legend-stat-val mono">${data.stats.awaitingReview}</span></div>
          <div class="legend-stat"><span class="legend-stat-label">Shipped today</span><span class="legend-stat-val mono">${data.stats.completedToday}</span></div>
          <div class="legend-stat"><span class="legend-stat-label">Avg cycle</span><span class="legend-stat-val mono">${formatCycle(data.stats.avgCycleMinutes)}</span></div>
        </div>

        <div class="legend-block">
          <div class="legend-head mono">SCOPE</div>
          <select class="repo-select" aria-label="Scope dashboard by repository">${repoOptions}</select>
          ${autoClaimToggle}
        </div>

        <div class="legend-block">
          <div class="legend-head mono">THROUGHPUT · 7D</div>
          <div class="spark-wrap">${buildSparkline(data.throughput7d)}</div>
        </div>

        <div class="operator-note">
          ${ICON_LOCK}
          <span>Read/write scoped to this branch only. Merge requires human approval &mdash; the agent never merges to main, and there is no merge control here.</span>
        </div>
      </aside>

      <main class="console">
        ${banner}
        <div class="topbar">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span class="topbar-scope mono">${selectedRepo ? esc(shortRepo(selectedRepo)) : 'ALL REPOS'}</span>
          <div class="topbar-sep"></div>
          <span class="topbar-mode mono">MODE <b>LIVE</b></span>
          <select class="theme-select" aria-label="Theme">${themeOptions}</select>
          <button class="view-toggle" type="button" data-view="cmux">CMUX &#9658;</button>
          <div class="topbar-fill"></div>
          <div class="topbar-stats">
            <div class="mini-stat"><span class="num mono">${data.stats.completedToday}</span><span class="lbl">Shipped today</span></div>
            <div class="mini-stat"><span class="num mono">${data.stats.awaitingReview}</span><span class="lbl">Awaiting review</span></div>
            <div class="mini-stat"><span class="num mono">${formatCycle(data.stats.avgCycleMinutes)}</span><span class="lbl">Avg cycle</span></div>
          </div>
        </div>

        <div class="panel newrun-panel">
          <div class="panel-head">
            <span class="panel-title">New run</span>
          </div>
          <div class="newrun-body">
            <div class="newrun-mode-toggle">
              <label class="newrun-mode-label">
                <input type="radio" class="newrun-mode" name="newrun-mode" value="ticket" checked>
                <span>Ticket</span>
              </label>
              <label class="newrun-mode-label">
                <input type="radio" class="newrun-mode" name="newrun-mode" value="freeform">
                <span>Free-form</span>
              </label>
            </div>
            <div class="newrun-fields">
              <input class="newrun-ticket" type="text" placeholder="Ticket ID (e.g. ABC-123)">
              <input class="newrun-title" type="text" placeholder="Title (optional)">
              <textarea class="newrun-task" placeholder="Describe the task..."></textarea>
              <select class="newrun-repo" aria-label="Repository for new run">${newRunRepoOptions}</select>
              <button class="newrun-launch">Launch run</button>
            </div>
          </div>
        </div>

        <div class="lanes-grid">
          <div class="panel">
            <div class="panel-head">
              <span class="panel-title">Backlog queue</span>
              <span class="panel-count mono">${queue.length}</span>
            </div>
            <ul class="queue-list lane-list">${queueItems}</ul>
          </div>

          <div class="panel">
            <div class="panel-head">
              <span class="panel-title">Agents running</span>
              <span class="panel-count mono">${activeRuns.length}</span>
            </div>
            <ul class="agent-list lane-list">${agentRows}</ul>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Recent runs</span>
            <span class="panel-count mono">${terminalRuns.length}</span>
          </div>
          <ul class="recent-runs-list lane-list">${recentRunItems}</ul>
        </div>

        <div class="panel pr-lookup">
          <div class="panel-head">
            <span class="panel-title">Review a PR</span>
          </div>
          <div class="pr-lookup-form">
            <input class="pr-lookup-input" placeholder="Paste a PR URL or owner/repo#number" />
            <button class="pr-lookup-go">Load PR</button>
          </div>
          <div class="pr-lookup-result"></div>
        </div>

        <div class="console-strip">
          <div class="panel panel-shipped">
            <div class="panel-head">
              <span class="panel-title">Recently shipped</span>
              <span class="panel-count mono">${data.shipped.length}</span>
            </div>
            <div class="shipped-grid">${shippedCards}</div>
          </div>

          <div class="panel">
            <div class="panel-head"><span class="panel-title">Activity feed</span></div>
            <div class="feed">${activityLines}</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Config</span>
          </div>
          <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
          <div class="config-list">${configRows}</div>
        </div>
      </main>
    </div>`;
}

export function renderPrPanel(pr: PrStatusView | null, canRerun: boolean): string {
  if (!pr) return '<div class="pr-panel empty-note">No PR found.</div>';
  const stateLabel: string = pr.merged ? 'Merged' : pr.draft ? 'Draft' : pr.state === 'closed' ? 'Closed' : 'Open';
  const stateChipClass: string = pr.merged ? 'chip-done' : pr.state === 'closed' ? 'chip-blocked' : 'chip-review';
  const checks: { passed: number; failed: number; pending: number } = pr.checks ?? { passed: 0, failed: 0, pending: 0 };
  const ciClass: string = checks.failed > 0 ? 'pr-ci mono pr-ci-bad' : 'pr-ci mono';
  const rerun: string = canRerun
    ? '<textarea class="pr-rerun-feedback" placeholder="Feedback for the agent to address"></textarea><button class="pr-rerun">Re-run with feedback</button><button class="pr-review-agent">Code-review with agent</button>'
    : '<div class="pr-no-rerun empty-note">Re-run unavailable: this repo is not checked out locally.</div>';
  return `
    <div class="pr-panel" data-pr-repo="${esc(pr.repo)}" data-pr-number="${pr.number}">
      <div class="pr-panel-head">
        <span class="chip ${stateChipClass}">${stateLabel}</span>
        <span class="${ciClass}">&#10003;${checks.passed} &#10007;${checks.failed} &#8943;${checks.pending}</span>
        <span class="chip chip-review">${esc(pr.reviewDecision)}</span>
        <span class="pr-branch mono">${esc(pr.headRefName)}</span>
        <span class="pr-comments mono">${pr.comments} comments</span>
        <a class="pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number}</a>
      </div>
      <div class="pr-review">
        <textarea class="pr-review-body" placeholder="Review comment"></textarea>
        <div class="pr-review-actions">
          <button class="pr-approve">Approve</button>
          <button class="pr-request-changes">Request changes</button>
          <button class="pr-comment">Comment</button>
        </div>
      </div>
      ${rerun}
    </div>`;
}

interface CmuxActionSpec {
  action: string;
  label: string;
}

const CMUX_UNIVERSAL_ACTIONS: CmuxActionSpec[] = [
  { action: 'enter', label: 'Enter' },
  { action: 'escape', label: 'Esc' },
  { action: 'interrupt', label: 'Ctrl-C' },
];

const CMUX_AGENT_ACTIONS: CmuxActionSpec[] = [
  { action: 'continue', label: 'Continue' },
  { action: 'stop', label: 'Stop' },
  { action: 'approve', label: 'Approve' },
];

function cmuxActionsFor(tab: CmuxTabView): CmuxActionSpec[] {
  return providerOf(tab) ? [...CMUX_UNIVERSAL_ACTIONS, ...CMUX_AGENT_ACTIONS] : CMUX_UNIVERSAL_ACTIONS;
}

const CMUX_TOPBAR: string = `
    <div class="cmux-topbar">
      <button class="view-toggle" type="button" data-view="dashboard">&#9668; Dashboard</button>
      <span class="cmux-topbar-title mono">CMUX CONTROL</span>
    </div>`;

interface CmuxNavKeySpec {
  key: string;
  label: string;
}

const CMUX_NAV_KEYS: CmuxNavKeySpec[] = [
  { key: 'up', label: '&#8593;' },
  { key: 'down', label: '&#8595;' },
  { key: 'left', label: '&#8592;' },
  { key: 'right', label: '&#8594;' },
  { key: 'tab', label: 'Tab' },
  { key: 'escape', label: 'Esc' },
];

export interface CmuxViewState {
  connected: boolean;
  tabs: CmuxTabView[];
  selectedSurface: string | null;
  screen: string;
  isCapturing: boolean;
}

export function renderCmuxView(state: CmuxViewState): string {
  if (!state.connected) {
    return `<div class="cmux-view">${CMUX_TOPBAR}<div class="panel empty-note">cmux not connected. Is the cmux app running?</div></div>`;
  }

  const list: string = state.tabs.length
    ? state.tabs
        .map(
          (t) => `
      <button class="cmux-tab${t.surfaceRef === state.selectedSurface ? ' is-selected' : ''}" type="button" data-surface="${esc(t.surfaceRef)}">
        <span class="cmux-tab-title">${esc(t.surfaceTitle)}</span>
        <span class="cmux-tab-meta mono">${esc(t.workspaceTitle)} &middot; ${esc(t.type)}</span>
      </button>`,
        )
        .join('')
    : '<div class="empty-note">No cmux tabs.</div>';

  const selected: CmuxTabView | null = state.tabs.find((t) => t.surfaceRef === state.selectedSurface) ?? null;

  const detail: string = selected
    ? `
      <div class="cmux-capture-row">
        <button class="cmux-capture-toggle${state.isCapturing ? ' is-active' : ''}" type="button" data-cmux-capture aria-pressed="${state.isCapturing ? 'true' : 'false'}">${state.isCapturing ? 'Capturing&hellip;' : 'Capture keyboard'}</button>
        ${state.isCapturing ? `<span class="cmux-capture-hint">Capturing &mdash; keystrokes sent to ${esc(selected.surfaceTitle)}</span>` : ''}
      </div>
      <pre class="cmux-screen mono${state.isCapturing ? ' is-capturing' : ''}" tabindex="0">${esc(state.screen)}</pre>
      <div class="cmux-keypad">
        ${CMUX_NAV_KEYS.map((k) => `<button class="cmux-keypad-btn" type="button" data-key="${esc(k.key)}">${k.label}</button>`).join('')}
      </div>
      <form class="cmux-send">
        <input class="cmux-input" name="text" placeholder="Send to ${esc(selected.surfaceTitle)}&hellip;" autocomplete="off" />
        <button type="submit">Send &#9166;</button>
      </form>
      <div class="cmux-actions">
        ${cmuxActionsFor(selected)
          .map((a) => `<button class="cmux-action" type="button" data-action="${esc(a.action)}">${esc(a.label)}</button>`)
          .join('')}
      </div>`
    : '<div class="empty-note">Select a tab to view its screen.</div>';

  return `<div class="cmux-view">${CMUX_TOPBAR}
    <div class="cmux-body">
      <div class="panel cmux-list">${list}</div>
      <div class="panel cmux-detail">${detail}</div>
    </div>
  </div>`;
}
