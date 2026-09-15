import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { escapeHtml as esc } from './logic/html';
import type { PrStatus, Priority, Ticket, TicketStatus } from './types';
import type { TriageGroupsView } from './data/triage';
import { defaultLayout, type PanelId, type RackLayout, type RackSlot } from './logic/rack';
import { EFFORT_OPTIONS, MODEL_OPTIONS, type AgentOption } from './logic/agentOptions';

function tuningSelects(prefix: string): string {
  const opts = (list: AgentOption[]): string =>
    list.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  return `<div class="tuning">
      <select class="${prefix}-model tuning-select" aria-label="Model">${opts(MODEL_OPTIONS)}</select>
      <select class="${prefix}-effort tuning-select" aria-label="Effort">${opts(EFFORT_OPTIONS)}</select>
    </div>`;
}
import type { AgentCaps, RunSummary } from './data/agents';
import type { UiConfig } from './data/config';
import type { PrStatusView } from './data/pr';
import type { CmuxTabView } from './logic/cmuxPanel';
import { providerOf } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';

const PRIORITY_CLASS: Record<Priority, string> = { P1: 'pri-p1', P2: 'pri-p2', P3: 'pri-p3' };

export const CONFIG_HELP: Record<string, string> = {
  AGENT_ADAPTER: "Which agent runs tasks: 'claude-code' (default) or 'command' (runs your custom AGENT_CMD).",
  AGENT_CMD: 'Shell command for the "command" adapter. Receives the task prompt and can run arbitrary commands — change with care.',
  AGENT_MAX_ATTEMPTS: 'Maximum times a single run retries before it is abandoned.',
  AGENT_MAX_COST_USD: 'Per-run spend ceiling in USD; the run stops once exceeded. Blank means no cap.',
  AUTO_CLAIM_INTERVAL_MS: 'How often (milliseconds) the auto-claim scheduler polls for backlog tickets. Interval changes apply on restart.',
  REPO_PROJECT_MAP: 'Comma-separated repo=jiraProject pairs, mapping each repository to the Jira project its tickets live in.',
  JIRA_PROJECT: 'Default Jira project key used when the selected repo has no explicit REPO_PROJECT_MAP entry.',
  JIRA_ASSIGNEE: 'Jira account that claimed tickets are assigned to (e.g. currentUser()).',
  JIRA_JQL: 'Optional JQL filter that narrows which tickets appear in the backlog queue.',
  GITHUB_REPO: 'Default owner/repo used for GitHub PR lookups when none is otherwise provided.',
  GITHUB_PR_AUTHOR: 'GitHub username whose authored PRs populate the Recently shipped and Activity panels.',
};

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { label: 'In review', chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
}

function reviewChip(decision: string): { cls: string; label: string } {
  if (decision === 'APPROVED') return { cls: 'chip-done', label: 'Approved' };
  if (decision === 'CHANGES_REQUESTED') return { cls: 'chip-blocked', label: 'Changes' };
  return { cls: 'chip-review', label: 'Review' };
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

const ICON_GRIP: string =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="4" r="1.15"/><circle cx="10.5" cy="4" r="1.15"/><circle cx="5.5" cy="8" r="1.15"/><circle cx="10.5" cy="8" r="1.15"/><circle cx="5.5" cy="12" r="1.15"/><circle cx="10.5" cy="12" r="1.15"/></svg>'

const ICON_COLLAPSE: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'

const ICON_EXPAND: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>'

function surfaceCollapseBtn(id: string, label: string, collapsed: boolean): string {
  return `<button class="surface-collapse" type="button" data-collapse-id="${esc(id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(label)}">${collapsed ? ICON_EXPAND : ICON_COLLAPSE}</button>`;
}

const ICON_INFO: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.5" fill="currentColor" stroke="none"/></svg>'

const ICON_CHECK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>'

const ICON_X_MARK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

const ICON_DOTS: string =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>'

const ICON_REQUEST: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></svg>'

const ICON_PENCIL: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12l-2.6.6L4 10z"/></svg>'

const ICON_KNOB: string =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.4" fill="currentColor" stroke="none"/><path d="M10 2.8v1.8M10 15.4v1.8M2.8 10h1.8M15.4 10h1.8M4.9 4.9l1.3 1.3M13.8 13.8l1.3 1.3M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3" stroke-linecap="round"/></svg>'

const ICON_BNC: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2"/></svg>'

const DIRECTION_CONTRACT: string = `<!--
  IMPECCABLE DIRECTION CONTRACT — seed key operate/direction 0bef9ada (form: benchtop instrument rack, grounded #7 assignment, user-picked over challengers + canon).
  THESIS: GoMaestro is a bench of rack-mounted test instruments — each panel is a rack unit the operator drags to reorder, stacks into a tabbed drawer, and powers down. Refuses the mission-control HUD and the incumbent patch-bay jackfield it replaces.
  OWN-WORLD: brushed-graphite faceplates seated on black rack rails; silkscreen small-caps labels in self-hosted JetBrains Mono; a phosphor-green oscilloscope graticule carries the live run log; amber seven-segment numerics for counts, cost, elapsed; LED indicator lamps (green live · amber queued · red fault) each with a shape tell so hue is never the sole signal; knurled-knob and BNC-jack accents; blanking panels for empty and powered-down slots.
  STORY: the operator arranges their bench, reads fleet state at a glance across lit faceplates, and launches/stops/reviews from momentary push-buttons — and there is no merge switch anywhere on the bench.
  FIRST VIEWPORT: a bench nameplate (brand plate, LIVE lamp, scope rotary, page tabs BENCH · TRIAGE · CMUX) over a two-bay rack of instrument faceplates; the oscilloscope log drawer seats below; the merge-gate note is screened onto a bench strip.
  FORM: benchtop instrument rack (operate, grounded candidate 7 of 7); seed 0bef9ada.
  FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`

function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo
}

const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;
const TICKET_RE_G = /\b[A-Z][A-Z0-9]+-\d+\b/g;

function jiraHref(baseUrl: string, id: string): string {
  return `${esc(baseUrl.replace(/\/+$/, ''))}/browse/${esc(id)}`;
}

function ticketLabel(id: string, baseUrl: string | null): string {
  if (baseUrl && TICKET_RE.test(id)) {
    return `<a class="ticket-link" href="${jiraHref(baseUrl, id)}" target="_blank" rel="noopener">${esc(id)}</a>`;
  }
  return esc(id);
}

function linkifyTickets(html: string, baseUrl: string | null): string {
  if (!baseUrl) return html;
  return html.replace(
    TICKET_RE_G,
    (id) => `<a class="ticket-link" href="${jiraHref(baseUrl, id)}" target="_blank" rel="noopener">${id}</a>`,
  );
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

export type PageView = 'dashboard' | 'triage' | 'cmux';

const PAGE_TABS: { view: PageView; label: string }[] = [
  { view: 'dashboard', label: 'Bench' },
  { view: 'triage', label: 'Triage' },
  { view: 'cmux', label: 'cmux' },
];

const PANEL_TITLE: Record<PanelId, string> = {
  newrun: 'New run',
  backlog: 'Backlog queue',
  running: 'Agents running',
  recent: 'Recent runs',
  pr: 'Review a PR',
  myprs: 'My open PRs',
  shipped: 'Recently shipped',
  activity: 'Activity feed',
  config: 'Config',
};

interface PanelDef {
  body: string;
  count: number | null;
  lamp: 'live' | 'queued' | 'idle';
}

export interface BenchHeadOpts {
  active: PageView;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  readout: { running: number; queued: number; review: number } | null;
  autoClaim: string;
}

export function renderBenchHead(opts: BenchHeadOpts): string {
  const sorted: string[] = [...opts.repos].sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));
  const scopeOptions: string = ['<option value="">All repos</option>']
    .concat(
      sorted.map(
        (repo) => `<option value="${esc(repo)}"${repo === opts.selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');
  const themeOptions: string = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === opts.themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');
  const tabs: string = PAGE_TABS.map(
    (t) =>
      `<button class="page-tab view-toggle${t.view === opts.active ? ' is-active' : ''}" type="button" data-view="${t.view}"${t.view === opts.active ? ' aria-current="page"' : ''}>${esc(t.label)}</button>`,
  ).join('');
  const readout: string = opts.readout
    ? `<div class="bench-readout mono" aria-label="Fleet status">
         <span class="seg"><b class="seg7">${opts.readout.running}</b> run</span>
         <span class="seg"><b class="seg7">${opts.readout.queued}</b> queue</span>
         <span class="seg"><b class="seg7">${opts.readout.review}</b> review</span>
       </div>`
    : '';
  return `
    <header class="bench-head">
      <div class="nameplate">
        <span class="nameplate-mark mono" aria-hidden="true">GM</span>
        <span class="nameplate-name">GoMaestro</span>
        <span class="nameplate-model mono">MDL·01 FLEET CONSOLE</span>
        <span class="bench-jacks" aria-hidden="true">${ICON_KNOB}${ICON_BNC}${ICON_BNC}</span>
      </div>
      <span class="lamp lamp-live is-pulsing" role="img" aria-label="Live">LIVE</span>
      ${readout}
      <div class="bench-controls">
        <select class="repo-select" aria-label="Scope by repository">${scopeOptions}</select>
        ${opts.autoClaim}
        <select class="theme-select" aria-label="Theme">${themeOptions}</select>
      </div>
      <nav class="page-tabs" aria-label="Views">${tabs}</nav>
    </header>`;
}

function renderRackSlot(slot: RackSlot, defs: Record<PanelId, PanelDef>, c: number, s: number): string {
  const active: PanelId = slot.active;
  const def: PanelDef = defs[active];
  const header: string =
    slot.panels.length > 1
      ? `<div class="slot-tabs" role="tablist">${slot.panels
          .map(
            (p) =>
              `<button class="slot-tab${p === active ? ' is-active' : ''}" type="button" role="tab" aria-selected="${p === active}" data-panel-tab="${p}">${esc(PANEL_TITLE[p])}</button>`,
          )
          .join('')}</div>`
      : `<span class="faceplate-title">${esc(PANEL_TITLE[active])}</span>`;
  const count: string = def.count != null ? `<span class="faceplate-count seg7">${def.count}</span>` : '';
  return `
      <section class="faceplate${slot.collapsed ? ' is-collapsed' : ''}" data-col="${c}" data-slot="${s}" data-panel="${active}">
        <div class="faceplate-head" data-drop="head" data-panel="${active}">
          <button class="rack-handle" draggable="true" data-panel="${active}" aria-label="Drag to move ${esc(PANEL_TITLE[active])}">${ICON_GRIP}</button>
          ${header}
          <span class="faceplate-lamp lamp lamp-${def.lamp}" aria-hidden="true"></span>
          ${count}
          <button class="panel-collapse" type="button" data-panel="${active}" aria-expanded="${slot.collapsed ? 'false' : 'true'}" aria-label="${slot.collapsed ? 'Expand' : 'Collapse'} ${esc(PANEL_TITLE[active])}">${slot.collapsed ? ICON_EXPAND : ICON_COLLAPSE}</button>
        </div>
        <div class="faceplate-body" data-drop="body" data-col="${c}" data-slot="${s}">${def.body}</div>
      </section>`;
}

function renderRack(layout: RackLayout, defs: Record<PanelId, PanelDef>): string {
  return `<div class="bench-rack" data-rack>${layout
    .map(
      (col, c) =>
        `<div class="rack-col" data-col="${c}">${col
          .map((slot, s) => renderRackSlot(slot, defs, c, s))
          .join('')}<div class="rack-endstop" data-drop="end" data-col="${c}" aria-hidden="true"></div></div>`,
    )
    .join('')}</div>`;
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
  layout: RackLayout = defaultLayout(),
  jiraBaseUrl: string | null = null,
): void {
  const queue = sortByPriority(data.queue);
  const scopedRuns: RunSummary[] = selectedRepo
    ? runs.filter((r) => r.repo === selectedRepo)
    : runs;
  const activeRuns: RunSummary[] = scopedRuns.filter((r) => r.status === 'running');
  const terminalRuns: RunSummary[] = scopedRuns.filter((r) => r.status !== 'running');

  const sortedRepos: string[] = [...repos].sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));

  const autoClaimToggle: string = selectedRepo
    ? `<label class="auto-claim"><input type="checkbox" class="auto-claim-toggle"${autoClaimRepos.includes(selectedRepo) ? ' checked' : ''}><span>Auto-claim</span></label>`
    : '';

  const queueItems = queue.length
    ? queue
        .map(
          (ticket, i) => `
      <li class="lane queue-item">
        <span class="lane-no mono">${laneNo(i)}</span>
        <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
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
        <span class="ticket-id">${ticketLabel(run.ticketId, jiraBaseUrl)}</span>
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
        pr.ticketId !== '—' ? ticketLabel(pr.ticketId, jiraBaseUrl) : '',
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
        <span class="feed-text${event.accent ? ' tag-accent' : ''}">${linkifyTickets(event.text, jiraBaseUrl)}</span>
      </div>`,
        )
        .join('')
    : '<div class="empty-note">No recent activity.</div>';

  const banner: string =
    degraded.length > 0
      ? `<div class="degraded-banner">Showing sample data for: ${degraded.join(', ')} — check server credentials.</div>`
      : '';

  const newRunRepoOptions: string = sortedRepos
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
        <span class="ticket-id">${ticketLabel(run.ticketId || 'freeform', jiraBaseUrl)}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        ${laneRail(statusInfo.laneState)}
        <span class="agent-cost mono">${costText}</span>
        ${prLink}
        <span class="chip ${statusInfo.chipClass}">${statusInfo.label}</span>
      </li>`;
        })
        .join('')
    : '<li class="empty-note">No past runs.</li>';

  const myPrItems: string = data.myOpenPrs.length
    ? data.myOpenPrs
        .map((pr) => {
          const chip = reviewChip(pr.reviewDecision);
          return `
      <li class="lane myprs-row" data-repo="${esc(pr.repo)}" data-number="${pr.number}" role="button" tabindex="0" aria-label="Open PR #${pr.number} in the review panel">
        <span class="ticket-id mono">#${pr.number}</span>
        <span class="queue-title">${esc(pr.title)}</span>
        <span class="agent-repo mono">${esc(shortRepo(pr.repo))}</span>
        ${pr.draft ? '<span class="chip chip-queued">Draft</span>' : ''}
        <span class="chip ${chip.cls}">${chip.label}</span>
      </li>`;
        })
        .join('')
    : '<li class="empty-note">No open pull requests.</li>';

  const configEntries: [string, unknown][] = Object.entries(uiConfig.config ?? {});
  const configRows: string = configEntries.length
    ? configEntries
        .map(([key, value]) => {
          const isOverridden: boolean = (uiConfig.overridden ?? []).includes(key);
          const help: string = CONFIG_HELP[key] ?? '';
          const hint: string = help
            ? ` <span class="config-hint" tabindex="0" role="img" aria-label="${esc(help)}" title="${esc(help)}">${ICON_INFO}</span>`
            : '';
          return `
      <div class="config-row" data-key="${esc(key)}"${help ? ` title="${esc(help)}"` : ''}>
        <span class="config-key mono">${esc(key)}${isOverridden ? ' <span class="config-overridden">(overridden)</span>' : ''}${hint}</span>
        <input class="config-input" type="text" value="${esc(String(value ?? ''))}">
        <button class="config-save" data-key="${esc(key)}">Save</button>
        <span class="config-error" role="alert"></span>
      </div>`;
        })
        .join('')
    : '<div class="empty-note">No configuration keys.</div>';

  const panelDefs: Record<PanelId, PanelDef> = {
    newrun: {
      lamp: 'idle',
      count: null,
      body: `
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
            ${tuningSelects('newrun')}
            <button class="newrun-launch">Launch run</button>
          </div>
        </div>`,
    },
    backlog: {
      lamp: queue.length ? 'queued' : 'idle',
      count: queue.length,
      body: `<ul class="queue-list lane-list">${queueItems}</ul>`,
    },
    running: {
      lamp: activeRuns.length ? 'live' : 'idle',
      count: activeRuns.length,
      body: `<ul class="agent-list lane-list">${agentRows}</ul>`,
    },
    recent: {
      lamp: 'idle',
      count: terminalRuns.length,
      body: `<ul class="recent-runs-list lane-list">${recentRunItems}</ul>`,
    },
    pr: {
      lamp: 'idle',
      count: null,
      body: `
        <div class="pr-lookup-form">
          <input class="pr-lookup-input" placeholder="Paste a PR URL or owner/repo#number" />
          <button class="pr-lookup-go">Load PR</button>
        </div>
        <div class="pr-lookup-result"></div>`,
    },
    myprs: {
      lamp: data.myOpenPrs.length ? 'queued' : 'idle',
      count: data.myOpenPrs.length,
      body: `<ul class="myprs-list lane-list">${myPrItems}</ul>`,
    },
    shipped: {
      lamp: 'idle',
      count: data.shipped.length,
      body: `<div class="shipped-grid">${shippedCards}</div>`,
    },
    activity: {
      lamp: 'idle',
      count: null,
      body: `
        <div class="throughput">
          <span class="throughput-label mono">Throughput · 7d</span>
          <div class="spark-wrap">${buildSparkline(data.throughput7d)}</div>
        </div>
        <div class="feed">${activityLines}</div>`,
    },
    config: {
      lamp: 'idle',
      count: null,
      body: `
        <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
        <div class="config-list">${configRows}</div>`,
    },
  };

  root.innerHTML = `${DIRECTION_CONTRACT}
    <div class="bench" data-page="dashboard">
      ${renderBenchHead({
        active: 'dashboard',
        repos,
        selectedRepo,
        themeId,
        readout: { running: activeRuns.length, queued: queue.length, review: data.stats.awaitingReview },
        autoClaim: autoClaimToggle,
      })}
      ${banner}
      ${renderRack(layout, panelDefs)}
      <div class="runs-drawer-slot"></div>
      <div class="operator-note">
        ${ICON_LOCK}
        <span>Read/write scoped to this branch only. Merge requires human approval &mdash; the agent never merges to main, and there is no merge control here.</span>
      </div>
      <footer class="app-footer mono">
        <span class="footer-attr">nloehlein@godaddy.com</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span>
        <span>GoMaestro v${esc(__APP_VERSION__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span>
        <span>updated ${esc(__BUILD_DATE__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span>
        <span>${repos.length} repo${repos.length === 1 ? '' : 's'} tracked</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span>
        <span>${activeRuns.length} running</span>
      </footer>
    </div>`;
}

export interface RunTabView {
  id: string;
  label: string;
  complete: boolean;
}

export function renderRunsDrawer(tabs: RunTabView[], activeId: string | null, collapsed: boolean = false): string {
  const strip: string = tabs
    .map(
      (t) => `
      <div class="run-tab${t.id === activeId ? ' is-active' : ''}" data-tabid="${esc(t.id)}">
        <button class="run-tab-select" type="button" data-tabid="${esc(t.id)}">
          <span class="run-tab-dot${t.complete ? ' is-complete' : ''}" aria-hidden="true"></span>
          <span class="run-tab-label">${esc(t.label)}</span>
        </button>
        <button class="run-tab-close" type="button" data-tabid="${esc(t.id)}" aria-label="Close ${esc(t.label)}">${ICON_CLOSE}</button>
      </div>`,
    )
    .join('');
  const emptyBody: string =
    tabs.length === 0
      ? '<div class="run-drawer-empty empty-note">No runs open. Click a running agent or a recent run to open it here.</div>'
      : '';
  const header: string =
    tabs.length === 0 ? '<span class="run-drawer-title mono">AGENT RUNS</span>' : '';
  const collapseBtn: string =
    tabs.length > 0 ? surfaceCollapseBtn('runs:drawer', 'agent runs', collapsed) : '';
  return `
    <div class="run-tabs" role="tablist">${header}${strip}${collapseBtn}</div>
    <div class="run-drawer-body mono">${emptyBody}</div>
    <div class="run-drawer-footer mono"></div>
    <div class="run-drawer-pr"></div>`;
}

export function renderPrPanel(pr: PrStatusView | null, canRerun: boolean): string {
  if (!pr) return '<div class="pr-panel empty-note">No PR found.</div>';
  const stateLabel: string = pr.merged ? 'Merged' : pr.draft ? 'Draft' : pr.state === 'closed' ? 'Closed' : 'Open';
  const stateChipClass: string = pr.merged ? 'chip-done' : pr.state === 'closed' ? 'chip-blocked' : 'chip-review';
  const checks: { passed: number; failed: number; pending: number } = pr.checks ?? { passed: 0, failed: 0, pending: 0 };
  const ciClass: string = checks.failed > 0 ? 'pr-ci mono pr-ci-bad' : 'pr-ci mono';
  const reviews: { requested: number; approved: number; changesRequested: number; commented: number } =
    pr.reviews ?? { requested: 0, approved: 0, changesRequested: 0, commented: 0 };
  const tally = (icon: string, n: number, label: string): string =>
    `<span class="tally" title="${label}"><span class="tally-ic" aria-hidden="true">${icon}</span>${n}</span>`;
  const ciBadge: string =
    `<span class="${ciClass}">${tally(ICON_CHECK, checks.passed, 'Checks passed')}${tally(ICON_X_MARK, checks.failed, 'Checks failed')}${tally(ICON_DOTS, checks.pending, 'Checks pending')}</span>`;
  const reviewersBadge: string =
    `<span class="pr-reviewers mono" aria-label="Reviewers requested ${reviews.requested}, approved ${reviews.approved}, changes requested ${reviews.changesRequested}, commented ${reviews.commented}">${tally(ICON_REQUEST, reviews.requested, 'Requested')}${tally(ICON_CHECK, reviews.approved, 'Approved')}${tally(ICON_X_MARK, reviews.changesRequested, 'Changes requested')}${tally(ICON_PENCIL, reviews.commented, 'Commented')}</span>`;
  const rerun: string = canRerun
    ? `<textarea class="pr-rerun-feedback" placeholder="Feedback for the agent to address"></textarea>${tuningSelects('pr')}<button class="pr-rerun">Re-run with feedback</button><button class="pr-review-agent">Code-review with agent</button>`
    : '<div class="pr-no-rerun empty-note">Re-run unavailable: this repo is not checked out locally.</div>';
  return `
    <div class="pr-panel" data-pr-repo="${esc(pr.repo)}" data-pr-number="${pr.number}">
      <div class="pr-panel-head">
        <span class="chip ${stateChipClass}">${stateLabel}</span>
        ${ciBadge}
        <span class="chip chip-review">${esc(pr.reviewDecision)}</span>
        ${reviewersBadge}
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

const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
};

const STATUS_CHIP_CLASS: Record<TicketStatus, string> = {
  backlog: 'chip-queued',
  'in-progress': 'chip-progress',
  'in-review': 'chip-review',
  done: 'chip-done',
};

function triageLaunchRow(ticket: Ticket, jiraBaseUrl: string | null, launchable: boolean): string {
  const action: string = launchable
    ? `<button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="Launch agent for ${esc(ticket.id)}">Launch</button>`
    : '';
  return `
      <li class="lane triage-row">
        <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
        <span class="queue-title">${esc(ticket.title)}</span>
        <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        ${action}
      </li>`;
}

function triageStatusRow(ticket: Ticket, jiraBaseUrl: string | null): string {
  return `
      <li class="lane triage-row">
        <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
        <span class="queue-title">${esc(ticket.title)}</span>
        <span class="chip ${STATUS_CHIP_CLASS[ticket.status]}">${STATUS_LABEL[ticket.status]}</span>
        <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
      </li>`;
}

function triageGroup(
  title: string,
  tickets: Ticket[],
  row: (t: Ticket, base: string | null) => string,
  jiraBaseUrl: string | null,
  emptyNote: string,
  hint: string = '',
  panelId: string = '',
  collapsed: boolean = false,
): string {
  const items: string = tickets.length
    ? sortByPriority(tickets).map((t) => row(t, jiraBaseUrl)).join('')
    : `<li class="empty-note">${esc(emptyNote)}</li>`;
  const hintEl: string = hint && tickets.length ? `<div class="triage-hint">${esc(hint)}</div>` : '';
  return `
        <div class="panel triage-group${collapsed ? ' is-collapsed' : ''}">
          <div class="panel-head">
            <span class="panel-title">${esc(title)}</span>
            <span class="panel-count mono">${tickets.length}</span>
            ${surfaceCollapseBtn(panelId, title, collapsed)}
          </div>
          ${hintEl}
          <ul class="lane-list triage-list">${items}</ul>
        </div>`;
}

export interface TriageViewOpts {
  repos: string[];
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
  degraded: boolean;
  themeId: string;
  collapsed?: Set<string>;
}

export function renderTriageView(groups: TriageGroupsView, opts: TriageViewOpts): string {
  const { repos, selectedRepo, jiraBaseUrl, degraded, themeId } = opts;
  const collapsed: Set<string> = opts.collapsed ?? new Set();
  const banner: string = degraded
    ? '<div class="degraded-banner">Jira unavailable — triage is empty.</div>'
    : '';
  const launchable: boolean = selectedRepo !== null;
  const launchRow = (t: Ticket, base: string | null): string => triageLaunchRow(t, base, launchable);
  const scopeHint: string = launchable ? '' : 'Select a repo to launch these against.';
  return `
    <div class="bench triage-view" data-page="triage">
      ${renderBenchHead({ active: 'triage', repos, selectedRepo, themeId, readout: null, autoClaim: '' })}
      ${banner}
      <div class="triage-grid">
        ${triageGroup('Unassigned · Backlog', groups.unassignedBacklog, launchRow, jiraBaseUrl, 'No unassigned backlog tickets.', scopeHint, 'triage:backlog', collapsed.has('triage:backlog'))}
        ${triageGroup('Unassigned · To Do', groups.unassignedTodo, launchRow, jiraBaseUrl, 'No unassigned to-do tickets.', scopeHint, 'triage:todo', collapsed.has('triage:todo'))}
        ${triageGroup('Mine · in flight', groups.mineOpen, triageStatusRow, jiraBaseUrl, 'Nothing assigned to you outside Done.', '', 'triage:mine', collapsed.has('triage:mine'))}
      </div>
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
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  collapsed?: Set<string>;
}

export function renderCmuxView(state: CmuxViewState): string {
  const head: string = renderBenchHead({
    active: 'cmux',
    repos: state.repos,
    selectedRepo: state.selectedRepo,
    themeId: state.themeId,
    readout: null,
    autoClaim: '',
  });
  if (!state.connected) {
    return `<div class="bench cmux-view" data-page="cmux">${head}<div class="panel empty-note">cmux not connected. Is the cmux app running?</div></div>`;
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

  const collapsed: Set<string> = state.collapsed ?? new Set();
  const listCollapsed: boolean = collapsed.has('cmux:list');
  const detailCollapsed: boolean = collapsed.has('cmux:detail');
  return `<div class="bench cmux-view" data-page="cmux">${head}
    <div class="cmux-body">
      <div class="panel cmux-list${listCollapsed ? ' is-collapsed' : ''}">
        <div class="panel-head"><span class="panel-title">Tabs</span>${surfaceCollapseBtn('cmux:list', 'Tabs', listCollapsed)}</div>
        <div class="cmux-list-body">${list}</div>
      </div>
      <div class="panel cmux-detail${detailCollapsed ? ' is-collapsed' : ''}">
        <div class="panel-head"><span class="panel-title">Screen</span>${surfaceCollapseBtn('cmux:detail', 'Screen', detailCollapsed)}</div>
        <div class="cmux-detail-body">${detail}</div>
      </div>
    </div>
  </div>`;
}
