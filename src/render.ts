import { renderLocalGit } from './renderLocalGit';
import { renderThemePreview } from './renderThemePreview';
import { emptyLocalGit, type LocalGitState } from './data/localGit';
import { routeHref, type PageView } from './logic/routes';
import type { PrInboxState, PrListState } from './data/prLists';
import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { escapeHtml as esc } from './logic/html';
import type { BugCard, BugsResponse, PrFileDiff, PrStatus, Priority, OpenPr, Ticket, TicketStatus } from './types';
import type { TriageGroupsView } from './data/triage';
import { defaultLayout, type PanelId, type RackLayout, type RackSlot } from './logic/rack';
import { EFFORT_OPTIONS, MODEL_OPTIONS, type AgentOption } from './logic/agentOptions';
import { REQUIRED_PR_APPROVALS } from './logic/prReviews';
import { RUN_LOG_PREVIEW_LIMIT } from './logic/runLog';
import { shortVoyageId } from './logic/voyageId';
import { PRE_PR_CONFIG_KEYS, PRE_PR_SETTING_DEFINITIONS } from './logic/prePrSettings';
import { defaultTriageFilters, filterTriageTickets, TRIAGE_PRIORITIES, TRIAGE_DATE_OPTIONS, type TriageFilters } from './logic/triageFilters';
import { DEFAULT_TRIAGE_PAGE_SIZE, TRIAGE_PAGE_SIZES, paginateTriageTickets, type TriageColumn, type TriagePages, type TriagePageSize } from './logic/triagePagination';

function tuningSelects(prefix: string, defaultModel: string = prefix === 'pr' ? '' : 'gpt-6-astra', defaultEffort: string = prefix === 'pr' ? '' : 'medium'): string {
  const opts = (list: AgentOption[], def: string): string =>
    list.map((o) => `<option value="${esc(o.value)}"${o.value === def ? ' selected' : ''}>${esc(prefix === 'pr' && !o.value ? 'Automatic by complexity' : o.label)}</option>`).join('');
  return `<div class="tuning">
      <select class="${prefix}-model tuning-select" aria-label="Model">${opts(MODEL_OPTIONS, defaultModel)}</select>
      <select class="${prefix}-effort tuning-select" aria-label="Effort">${opts(EFFORT_OPTIONS, defaultEffort)}</select>
    </div>`;
}
import type { AgentCaps, RunSummary } from './data/agents';
import type { UiConfig } from './data/config';
import type { PrStatusView } from './data/pr';
import type { CmuxTabView } from './logic/cmuxPanel';
import { providerOf } from './logic/cmuxPanel';
import { DEFAULT_THEME_ID, THEMES } from './data/themes';

const PRIORITY_CLASS: Record<Priority, string> = { P0: 'pri-p0', P1: 'pri-p1', P2: 'pri-p2', P3: 'pri-p3', P4: 'pri-p4' };

export const CONFIG_HELP: Record<string, string> = {
  JIRA_ENABLED: 'Use Jira tickets for voyages; disable to use local todos instead. Applies immediately. Example: false',
  GITHUB_REVIEW_WATCH_ENABLED: 'Automatically review GitHub PRs requesting your review every five minutes: true or false. Changes apply immediately. Example: true',
  SLACK_WATCH_ENABLED: 'Enable automatic PR reviews from the watched Slack channel: true or false. Changes apply immediately. Example: true',
  SLACK_CLIENT_ID: 'Slack client route context from the signed-in browser URL: the value after /client/. Example: T0123456789',
  SLACK_CHANNEL_ID: 'Exact Slack channel ID to watch. Only messages matching this channel are eligible for automatic review. Example: C0123456789',
  SLACK_CHANNEL_NAME: 'Channel name used in the Slack search query, without #. Example: pr-reviews',
  SLACK_BROWSER_SURFACE: 'Optional cmux browser surface containing signed-in Slack. Set this when multiple Slack browser surfaces are open. Example: surface:17',
  SLACK_REVIEW_CHANNEL: 'Slack channel for manual PR review requests. Use a channel name or ID. Example: airo-editing',
  SLACK_REVIEW_MENTION: 'Slack user group to mention in manual PR review requests. Use a group handle or ID. Example: airo-editing-squad',
  AGENT_ADAPTER: "Which agent runs tasks: 'codex' (default), 'claude-code', or 'command' (runs your custom AGENT_CMD). Example: codex",
  AGENT_CMD: 'Shell command for the "command" adapter, run no-shell (argv only). Placeholders {ticket} {repo} {title} are substituted, then it receives the task prompt. Example: my-agent --repo {repo} --ticket {ticket}',
  AGENT_MAX_ATTEMPTS: 'Total attempts for existing-PR voyages, including the initial attempt. New coding voyages use the separate pre-PR review rounds. Example: 1',
  AGENT_MAX_COST_USD: 'Per-voyage spend ceiling in USD; the voyage stops once exceeded. Blank means no cap. Example: 5.00',
  PRE_PR_REVIEWER_COUNT: 'Independent reviewer sessions per round: 1 uses the writer\'s CLI; 2 also uses the other supported CLI when installed. An installed reviewer that fails blocks publication. Example: 2',
  PRE_PR_MAX_ROUNDS: 'Maximum review rounds, including the initial review. Each additional round allows fixes followed by every reviewer reviewing again. Unresolved findings block the PR. Example: 3',
  PRE_PR_STAGE_TIMEOUT_MINUTES: 'Time limit in minutes for each implementation, fix, or reviewer session. A timed-out session blocks publication and retains the worktree. Example: 45',
  AUTO_CLAIM_INTERVAL_MS: 'How often (milliseconds) the auto-claim scheduler polls for backlog tickets. Interval changes apply on restart. Example: 60000',
  REPO_PROJECT_MAP: 'Comma-separated repo=jiraProject pairs, mapping each repository to the Jira project its tickets live in. Example: gdcorp-partners/airo-app-builder=AIROBUILD,gdcorp-enm/conversations-web=LEKA',
  JIRA_PROJECT: 'Default Jira project key used when the selected repo has no explicit REPO_PROJECT_MAP entry. Example: AIROBUILD',
  JIRA_ASSIGNEE: 'Jira account that claimed tickets are assigned to — currentUser() or an accountId. Example: currentUser()',
  JIRA_JQL: 'Optional JQL filter that narrows which tickets appear in the backlog queue. Example: labels = agent-ready AND priority >= High',
  GITHUB_REPO: 'Default owner/repo used for GitHub PR lookups when none is otherwise provided. Example: gdcorp-partners/airo-app-builder',
  GITHUB_PR_AUTHOR: 'GitHub username whose authored PRs populate the Out to sea and Ship\'s log panels. Example: nloehlein-godaddy',
};

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { label: 'In review', chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
  closed: { label: 'Closed', chipClass: 'chip-closed' },
}

function reviewChip(decision: string): { cls: string; label: string } {
  if (decision === 'APPROVED') return { cls: 'chip-done', label: 'Approved' };
  if (decision === 'CHANGES_REQUESTED') return { cls: 'chip-blocked', label: 'Changes' };
  return { cls: 'chip-review', label: 'Review' };
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

const ICON_COPY: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1.2"/><path d="M3 10.5H2.5V2.5h7V3"/></svg>';

const ICON_OPEN: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13 3l-7 7M6.5 3H3v10h10V9.5"/></svg>';

const ICON_X_MARK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

const ICON_DOTS: string =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>'

export function renderVoyageResult(run: RunSummary): string {
  const results: Record<string, { label: string; tone: string; icon: string }> = {
    APPROVE: { label: 'Review recommendation: Approve', tone: 'approved', icon: ICON_CHECK },
    REQUEST_CHANGES: { label: 'Review recommendation: Request changes', tone: 'changes', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v8m0-4h4a3 3 0 0 0 3-3V4"/><circle cx="5" cy="2.5" r="1.5"/><circle cx="5" cy="13.5" r="1.5"/><circle cx="12" cy="2.5" r="1.5"/></svg>' },
    COMMENT: { label: 'Review recommendation: Comment only', tone: 'commented', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5h-11v8h3v3l3-3h5z"/><path d="M5 5.5h6M5 7.5h4"/></svg>' },
  };
  const review = run.status === 'succeeded' && typeof run.reviewOutcome === 'string' && Object.hasOwn(results, run.reviewOutcome)
    ? results[run.reviewOutcome] : undefined;
  const result = review ?? (run.status === 'failed'
    ? { label: 'Voyage failed', tone: 'failed', icon: ICON_X_MARK }
    : run.status === 'stopped'
      ? { label: 'Voyage stopped', tone: 'unknown', icon: ICON_STOP }
      : run.status === 'running'
        ? { label: 'Voyage underway', tone: 'running', icon: ICON_DOTS }
        : run.status === 'queued'
          ? { label: 'Voyage queued', tone: 'unknown', icon: ICON_DOTS }
          : run.status === 'succeeded'
            ? { label: 'Completed · No review recommendation recorded', tone: 'unknown', icon: ICON_INFO }
            : { label: `Voyage status: ${run.status || 'Unknown'}`, tone: 'unknown', icon: ICON_INFO });
  const verdict = typeof run.reviewVerdict === 'string' ? run.reviewVerdict.slice(0, 240) : '';
  const title = review ? `${result.label}. Published as a GitHub comment.${verdict ? ` ${verdict}` : ''}` : result.label;
  return `<span class="voyage-result voyage-result-${result.tone}" role="img" aria-label="${esc(result.label)}" title="${esc(title)}">${result.icon}</span>`;
}

const ICON_REDO: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 3.5v3h-3"/><path d="M12.2 6.4A5 5 0 1 0 13 9.6"/></svg>'

const HELM_EMBLEM: string =
  '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><use href="/helm-emblem.svg#helm-emblem" /></svg>';

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

export type { PageView } from './logic/routes';

const PAGE_TABS: { view: PageView; label: string }[] = [
  { view: 'dashboard', label: 'Helm' },
  { view: 'prs', label: 'PR' },
  { view: 'triage', label: 'Triage' },
  { view: 'todos', label: 'Todos' },
  { view: 'cmux', label: 'Terminal' },
  { view: 'bugs', label: 'Bugs' },
  { view: 'runs', label: 'Voyages' },
  { view: 'config', label: 'Config' },
];

const PANEL_TITLE: Record<PanelId, string> = {
  newrun: 'New voyage',
  backlog: 'Backlog queue',
  underway: 'Mine · underway',
  running: 'Active crew',
  recent: 'Recent voyages',
  repoprs: 'Open PRs',
  shipped: 'Out to sea',
  activity: "Ship's log",
};

interface PanelDef {
  body: string;
  count: number | null;
  lamp: 'live' | 'queued' | 'idle';
}

export interface HelmHeadOpts {
  active: PageView;
  jiraEnabled?: boolean;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  readout: { running: number | null; queued: number | null; review: number | null } | null;
}

export function renderHelmHead(opts: HelmHeadOpts): string {
  const sorted: string[] = [...opts.repos].sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));
  const scopeOptions: string = ['<option value="">All repos</option>']
    .concat(
      sorted.map(
        (repo) => `<option value="${esc(repo)}"${repo === opts.selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');
  const tabs: string = PAGE_TABS.filter(t => t.view === 'todos' ? opts.jiraEnabled === false
    : t.view === 'triage' || t.view === 'bugs' ? opts.jiraEnabled !== false : true).map(
    (t) =>
      `<a class="page-tab view-toggle${t.view === opts.active ? ' is-active' : ''}" href="${esc(routeHref({ view: t.view, repo: opts.selectedRepo }))}" data-view="${t.view}" role="tab" id="page-tab-${t.view}" aria-selected="${t.view === opts.active}" aria-controls="page-content" tabindex="${t.view === opts.active ? 0 : -1}"${t.view === opts.active ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`,
  ).join('');
  const readout = `<div class="helm-readout mono" aria-label="Fleet status">
    ${(['running', 'queued', 'review'] as const).map((key) => {
      const value = opts.readout?.[key];
      const known = typeof value === 'number' && Number.isFinite(value);
      const label = key === 'running' ? 'underway' : key === 'queued' ? 'queue' : 'review';
      return `<span class="seg"><b class="seg7" data-fleet-count="${key}"${known ? '' : ' title="Not loaded for this repository"'}>${known ? value : '—'}</b> ${label}</span>`;
    }).join('')}
  </div>`;
  return `
    <header class="helm-head">
      <div class="nameplate">
        <span class="nameplate-mark" aria-hidden="true">${HELM_EMBLEM}</span>
        <div class="nameplate-scope">
          <span class="nameplate-name">Helmsman <span class="nameplate-alpha">Alpha</span></span>
          <select class="repo-select" aria-label="Scope by repository">${scopeOptions}</select>
        </div>
      </div>
      ${readout}
      <div class="helm-controls">
        <span class="lamp lamp-live is-pulsing" role="img" aria-label="Live">LIVE</span>
      </div>
    </header>
    <nav class="page-tabs" role="tablist" aria-label="Views">${tabs}</nav>`;
}

export function renderAppShell(opts: HelmHeadOpts, content: string): string {
  const running = opts.readout?.running ?? '—';
  return `<div class="helm${opts.active === 'dashboard' ? '' : ` ${opts.active}-view`}" data-page="${opts.active}">
    ${renderHelmHead(opts)}
    <main class="page-content" id="page-content" role="tabpanel" aria-labelledby="page-tab-${opts.active}" tabindex="0">${content}</main>
    <footer class="app-footer mono">
      <div class="operator-note">${ICON_LOCK}<span>Read/write scoped to this branch only. Merge requires human approval &mdash; the agent never merges to main, and there is no merge control here.</span></div>
      <div class="footer-meta">
        <span class="footer-attr">nloehlein@godaddy.com</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>Helmsman v${esc(__APP_VERSION__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>updated ${esc(__BUILD_DATE__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-repos>${opts.repos.length} repo${opts.repos.length === 1 ? '' : 's'} tracked</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-running>${running} underway</span>
      </div>
    </footer>
  </div>`;
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
  return `<div class="helm-rack" data-rack>${layout
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
  _autoClaimRepos: string[] = [],
  caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null },
  themeId: string = DEFAULT_THEME_ID,
  layout: RackLayout = defaultLayout(),
  jiraBaseUrl: string | null = null,
  repoPrs?: PrListState,
  jiraEnabled: boolean = true,
): void {
  const queue = sortByPriority(data.queue);
  const scopedRuns: RunSummary[] = selectedRepo
    ? runs.filter((r) => r.repo === selectedRepo)
    : runs;
  const activeRuns: RunSummary[] = scopedRuns.filter((r) => r.status === 'running');
  const terminalRuns: RunSummary[] = scopedRuns.filter((r) => r.status !== 'running');
  const underway = Array.isArray(data.underway) ? data.underway.filter(ticket => ticket && ticket.status !== 'done') : [];
  const underwayKnown = data.underwayAvailable !== false && Array.isArray(data.underway);
  const underwayItems = underwayKnown && underway.length
    ? sortByPriority(underway).map(ticket => triageStatusRow(ticket, jiraBaseUrl, jiraEnabled ? selectedRepo : null)).join('')
    : `<li class="empty-note">${underwayKnown ? jiraEnabled ? 'No unfinished tickets assigned to you.' : 'No todos in progress or review.' : 'Underway tickets unavailable.'}</li>`;

  const sortedRepos: string[] = [...repos].sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));

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
        <button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="Launch voyage for ${esc(ticket.id)}">Launch</button>
      </li>`,
        )
        .join('')
    : `<li class="empty-note">${jiraEnabled ? 'No backlog tickets assigned.' : 'No todos ready to launch. Add a description and set the state to To do.'}</li>`;

  const agentRows: string = activeRuns.length
    ? activeRuns
        .map(
          (run, i) => `
      <li class="lane agent-row" data-runid="${esc(run.id)}">
        <span class="lane-no mono">${laneNo(i)}</span>
        <span class="voyage-identity"><span class="ticket-id">${ticketLabel(run.ticketId, jiraBaseUrl)}</span>${renderVoyageId(run.id)}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        ${laneRail('live')}
        <span class="agent-elapsed mono">${formatRelativeTime(run.startedAt, now)}</span>
        ${caps.maxAttempts > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}/${caps.maxAttempts}</span>` : run.attempt > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}</span>` : ''}
        ${run.costUsd != null ? `<span class="agent-cost mono">$${run.costUsd.toFixed(2)}${caps.maxCostUsd != null ? `/$${caps.maxCostUsd.toFixed(2)}` : ''}</span>` : ''}
        <span class="chip chip-progress">Running</span>
        <button class="agent-stop" data-runid="${esc(run.id)}" aria-label="Stop voyage ${esc(run.ticketId)}">${ICON_STOP}</button>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No crew tasks underway.</li>';

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
    : '<div class="empty-note">No recent log entries.</div>';

  const sampleSources = degraded.filter(source => source !== 'jira-underway');
  const banner: string =
    sampleSources.length > 0
      ? `<div class="degraded-banner">${jiraEnabled && !selectedRepo ? 'Showing sample data for' : 'Unavailable integrations'}: ${sampleSources.join(', ')} — check server credentials.</div>`
      : '';

  const newRunRepoOptions: string = sortedRepos
    .map((repo) => `<option value="${esc(repo)}"${repo === selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`)
    .join('');

  const recentRunItems: string = terminalRuns.length
    ? terminalRuns.map(run => renderVoyage(run, now)).join('')
    : '<li class="empty-note">No past voyages.</li>';

  const repoPrCount: number = validListPrs(scopeRepoPrs(selectedRepo, repoPrs)).length;

  const panelDefs: Record<PanelId, PanelDef> = {
    newrun: {
      lamp: 'idle',
      count: null,
      body: `${jiraEnabled ? '' : `<p class="config-warning"><a class="app-link" href="${esc(routeHref({ view: 'todos', repo: selectedRepo }))}">Create or launch a todo →</a></p>`}
        <div class="newrun-body">
          <div class="newrun-mode-toggle">
            ${jiraEnabled ? `<label class="newrun-mode-label">
              <input type="radio" class="newrun-mode" name="newrun-mode" value="ticket" checked>
              <span>Ticket</span>
            </label>` : ''}
            <label class="newrun-mode-label">
              <input type="radio" class="newrun-mode" name="newrun-mode" value="freeform"${jiraEnabled ? '' : ' checked'}>
              <span>Free-form</span>
            </label>
          </div>
          <div class="newrun-fields">
            ${jiraEnabled ? `<input class="newrun-ticket" type="text" placeholder="Ticket ID (e.g. ABC-123)">
            <input class="newrun-title" type="text" placeholder="Title (optional)">` : ''}
            <textarea class="newrun-task" placeholder="Describe the task..."></textarea>
            <select class="newrun-repo" aria-label="Repository for new voyage">${newRunRepoOptions}</select>
            ${tuningSelects('newrun')}
            <button class="newrun-launch">Launch voyage</button>
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
    underway: {
      lamp: underwayKnown && underway.length ? 'queued' : 'idle',
      count: underwayKnown ? underway.length : null,
      body: `${jiraEnabled && underwayKnown && underway.length && !selectedRepo ? '<div class="triage-hint">Select a repository to launch a voyage.</div>' : ''}<ul class="underway-list lane-list">${underwayItems}</ul>`,
    },
    recent: {
      lamp: 'idle',
      count: terminalRuns.length,
      body: `<ul class="recent-runs-list lane-list">${recentRunItems}</ul>`,
    },
    repoprs: {
      lamp: repoPrCount ? 'queued' : 'idle',
      count: repoPrCount,
      body: renderRepoPrs(selectedRepo, repoPrs),
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
  };

  root.innerHTML = renderAppShell({
    active: 'dashboard', repos, selectedRepo, themeId,
    readout: { running: activeRuns.length, queued: queue.length, review: data.stats.awaitingReview },
  }, `${banner}${renderRack(layout, panelDefs)}<div class="runs-drawer-slot"></div>`);
}

function renderVoyageId(id: unknown): string {
  const shortId = shortVoyageId(id);
  return shortId && typeof id === 'string'
    ? `<button type="button" class="voyage-id mono" data-copy-run-id="${esc(id)}" title="${esc(id)}" aria-label="Copy full voyage ID ${esc(id)}">${ICON_COPY}<span>${esc(shortId)}</span><span class="voyage-copy-feedback" role="status" aria-live="polite"></span></button>`
    : '';
}

export function renderVoyageRetry(id: string, iconOnly = false): string {
  if (typeof id !== 'string' || id.startsWith('err-') || !/^[a-z\d_-]{1,128}$/i.test(id)) return '';
  return `<button type="button" class="voyage-retry" data-retry-run-id="${esc(id)}" aria-label="Retry failed voyage ${esc(id)}" title="Start a fresh voyage with the original task and settings">${ICON_REDO}<span${iconOnly ? ' class="sr-only"' : ''}>Retry</span></button><span class="voyage-retry-feedback" data-retry-feedback-for="${esc(id)}" role="status" aria-live="polite"></span>`;
}

export interface RunTabView {
  id: string;
  label: string;
  complete: boolean;
  status?: string;
}

export function runTabStatus(status?: string, complete = false): { kind: string; label: string } {
  const labels: Record<string, string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', stopped: 'Stopped', queued: 'Queued', completed: 'Completed' };
  const kind = status && Object.hasOwn(labels, status) ? status : complete ? 'completed' : 'running';
  return { kind, label: labels[kind] ?? 'Running' };
}

export function renderRunsDrawer(tabs: RunTabView[], activeId: string | null, collapsed: boolean = false): string {
  const strip: string = tabs
    .map(
      (t, index) => {
        const status = runTabStatus(t.status, t.complete);
        const selected = t.id === activeId;
        return `
      <div class="run-tab${selected ? ' is-active' : ''}" data-tabid="${esc(t.id)}" data-run-status="${status.kind}" role="presentation">
        <button class="run-tab-select" type="button" data-tabid="${esc(t.id)}" role="tab" id="run-tab-${esc(encodeURIComponent(t.id))}" aria-selected="${selected}" aria-controls="run-log-panel" tabindex="${selected || activeId === null && index === 0 ? 0 : -1}" title="${esc(t.label)}">
          <span class="run-tab-label">${esc(t.label)}</span>
          <span class="run-tab-status">${status.label}</span>
        </button>
        <div class="run-tab-meta">${!t.id.startsWith('err-') ? renderVoyageId(t.id) : ''}
          <div class="run-tab-actions">${!t.id.startsWith('err-') ? `<a class="run-tab-open app-link pane-link" href="${esc(routeHref({ view: 'runs', run: t.id, pane: 'tasks' }))}" aria-label="Open ${esc(t.label)} in Voyages" title="Open voyage">${ICON_OPEN}</a>` : ''}
          <button class="run-tab-close" type="button" data-tabid="${esc(t.id)}" aria-label="Close ${esc(t.label)}" title="Close voyage">${ICON_CLOSE}</button></div>
        </div>
      </div>`;
      },
    )
    .join('');
  const emptyBody: string =
    tabs.length === 0
      ? '<div class="run-drawer-empty empty-note">No crew tasks open. Select active crew or a recent voyage to view its tasks here.</div>'
      : '';
  const header: string =
    tabs.length === 0 ? '<span class="run-drawer-title mono">CREW TASKS</span>' : '';
  const collapseBtn: string =
    tabs.length > 0 ? surfaceCollapseBtn('runs:drawer', 'crew tasks', collapsed) : '';
  const activeTab = tabs.find(tab => tab.id === activeId);
  const logToolbar = activeId && !activeId.startsWith('err-') && /^[a-z\d_-]{1,128}$/i.test(activeId)
    ? `<div class="run-log-toolbar mono">${renderVoyageId(activeId)}<span>Recent output · up to ${RUN_LOG_PREVIEW_LIMIT} entries</span><a class="run-log-download" href="/api/agents/${encodeURIComponent(activeId)}/log/download" download title="Includes earlier output and full-length entries">Download full log</a></div>`
    : '';
  return `
    <div class="run-tabs" role="tablist" aria-label="Open voyages">${header}${strip}${collapseBtn}</div>
    ${logToolbar}
    <div class="run-drawer-retry">${activeTab?.status === 'failed' ? renderVoyageRetry(activeTab.id) : ''}</div>
    <div class="run-drawer-body mono" id="run-log-panel" role="tabpanel"${activeId ? ` aria-labelledby="run-tab-${esc(encodeURIComponent(activeId))}"` : ' aria-label="Voyage output"'} tabindex="0">${emptyBody}</div>
    <div class="run-drawer-footer mono"></div>
    <div class="run-drawer-pr"></div>`;
}

function prTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  const date = new Date(value);
  const label = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<time datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString(undefined, { timeZoneName: 'short' }))}">${esc(label)}</time>`;
}

export function renderPrPanel(pr: PrStatusView | null, canRerun: boolean, showOpenInTab: boolean = false): string {
  if (!pr) return '<div class="pr-panel empty-note">No PR found.</div>';
  const stateLabel: string = pr.merged ? 'Merged' : pr.draft ? 'Draft' : pr.state === 'closed' ? 'Closed' : 'Open';
  const stateChipClass: string = pr.merged ? 'chip-done' : pr.state === 'closed' ? 'chip-blocked' : 'chip-review';
  const checks: { passed: number; failed: number; pending: number } = pr.checks ?? { passed: 0, failed: 0, pending: 0 };
  const ciClass: string = checks.failed > 0 ? 'pr-ci mono pr-ci-bad' : 'pr-ci mono';
  const tally = (icon: string, n: number, label: string): string =>
    `<span class="tally" title="${label}"><span class="tally-ic" aria-hidden="true">${icon}</span>${n}</span>`;
  const ciBadge: string =
    `<span class="${ciClass}" aria-label="Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending"><span class="pr-meta-label">Checks</span>${tally(ICON_CHECK, checks.passed, 'Checks passed')}${tally(ICON_X_MARK, checks.failed, 'Checks failed')}${tally(ICON_DOTS, checks.pending, 'Checks pending')}</span>`;
  const approved = pr.reviews?.approved;
  const changesRequested = pr.reviews?.changesRequested;
  const reviewsKnown = pr.reviewsAvailable !== false && typeof approved === 'number' && Number.isSafeInteger(approved) && approved >= 0
    && typeof changesRequested === 'number' && Number.isSafeInteger(changesRequested) && changesRequested >= 0;
  const remaining = reviewsKnown ? Math.max(0, REQUIRED_PR_APPROVALS - approved) : REQUIRED_PR_APPROVALS;
  const approvalsLabel = reviewsKnown
    ? `${approved}/${REQUIRED_PR_APPROVALS} approvals${remaining ? ` · ${remaining} needed` : ''}`
    : `Approvals unavailable · ${REQUIRED_PR_APPROVALS} required`;
  const approvalsClass = reviewsKnown && !remaining && !changesRequested ? 'chip-done' : 'chip-review';
  const viewerReviewLabels: Record<string, string> = {
    APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented', DISMISSED: 'Dismissed',
  };
  const viewerReviewLabel: string | undefined = pr.viewerReview && Object.hasOwn(viewerReviewLabels, pr.viewerReview)
    ? viewerReviewLabels[pr.viewerReview]
    : undefined;
  const title: string = typeof pr.title === 'string' ? pr.title.trim() : '';
  const authorLogin: string = typeof pr.authorLogin === 'string' ? pr.authorLogin.trim() : '';
  const viewerReviewBadge: string = viewerReviewLabel
    ? `<span class="chip pr-viewer-review ${reviewChip(pr.viewerReview ?? '').cls}">Your review: ${viewerReviewLabel}</span>`
    : '';
  const reviewTimeKnown = pr.reviewsAvailable !== false && typeof pr.viewerReviewedAt === 'string' && Number.isFinite(Date.parse(pr.viewerReviewedAt));
  const reviewTime = prTimestamp(reviewTimeKnown ? pr.viewerReviewedAt : undefined,
    pr.reviewsAvailable === true && !pr.viewerReview && pr.viewerReviewedAt === undefined ? 'Not reviewed yet' : 'Unavailable');
  const canCompareCommits = reviewTimeKnown && typeof pr.headSha === 'string' && pr.headSha.trim()
    && typeof pr.viewerReviewedCommitId === 'string' && pr.viewerReviewedCommitId.trim();
  const commitChanged = canCompareCommits && pr.headSha !== pr.viewerReviewedCommitId;
  const reviewFreshness = canCompareCommits
    ? `<span class="pr-review-freshness${commitChanged ? ' chip chip-review' : ''}">${commitChanged ? 'New commits since your review' : 'You reviewed the current commit'}</span>`
    : '';
  const canRelaunch: boolean = canRerun && pr.isOwnPr === true;
  const feedback: string = canRelaunch
    ? '<textarea class="pr-rerun-feedback" aria-label="Feedback for the crew to address" placeholder="Feedback for the crew to address"></textarea>'
    : '';
  const rerun: string = canRerun
    ? `<div class="pr-crew-controls">${feedback}${tuningSelects('pr')}<div class="pr-review-actions">${canRelaunch ? '<button class="pr-rerun">Relaunch with feedback</button>' : ''}<button class="pr-review-agent">Code review with crew</button></div><div class="pr-voyage-links"><a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo: pr.repo, pr: pr.number, pane: 'newrun', mode: 'review' }))}">Link to crew review ↗</a>${canRelaunch ? `<a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo: pr.repo, pr: pr.number, pane: 'newrun', mode: 'rerun' }))}">Link to relaunch ↗</a>` : ''}</div></div>`
    : '<div class="pr-no-rerun empty-note">Crew actions unavailable: this repo is not checked out locally.</div>';
  return `
    <div class="pr-panel" data-pr-repo="${esc(pr.repo)}" data-pr-number="${pr.number}">
      <div class="pr-panel-head">
        <div class="pr-panel-heading">
          <div class="pr-panel-identity">
            ${title ? `<h3 class="pr-panel-title">${esc(title)}</h3>` : ''}
            <div class="pr-panel-byline"><a class="pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(pr.repo)} #${pr.number}</a>${authorLogin ? `<span class="pr-author">by ${esc(authorLogin)}</span>` : ''}</div>
          </div>
          <div class="pr-panel-status">
            <span class="chip ${stateChipClass}">${stateLabel}</span>
            <span class="chip pr-approval-progress ${approvalsClass}" title="${REQUIRED_PR_APPROVALS} distinct reviewer approvals required">${approvalsLabel}</span>
            ${reviewsKnown && changesRequested > 0 ? `<span class="chip pr-decision-chip chip-blocked">Changes requested (${changesRequested})</span>` : ''}
            ${viewerReviewBadge}
          </div>
        </div>
        <div class="pr-panel-meta">
          <div class="pr-panel-context">
            ${pr.headRefName ? `<span class="pr-branch mono"><span class="pr-meta-label">Branch</span>${esc(pr.headRefName)}</span>` : ''}
            ${ciBadge}
            <span class="pr-comments mono">${pr.comments} ${pr.comments === 1 ? 'comment' : 'comments'}</span>
          </div>
          ${showOpenInTab ? `<button class="pr-open-in-tab" type="button" data-repo="${esc(pr.repo)}" data-number="${pr.number}">Open in PR tab ↗</button>` : ''}
        </div>
        <div class="pr-panel-timing">
          <span class="pr-last-reviewed"><span class="pr-meta-label">Last reviewed by you</span>${reviewTime}</span>
          <span class="pr-last-updated" title="Latest GitHub PR activity, including commits, comments, and reviews"><span class="pr-meta-label">Last updated</span>${prTimestamp(pr.updatedAt, 'Unavailable')}</span>
          ${reviewFreshness}
        </div>
      </div>
      ${pr.isOwnPr === true && pr.state === 'open' && !pr.merged ? slackReviewButton(pr.repo, pr.number) : ''}
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

export interface PrViewState {
  repo: string | null;
  number: number | null;
  pr: PrStatusView | null;
  diff: PrFileDiff[] | null;
  loading: boolean;
}

export interface PrViewOpts {
  runs?: RunSummary[];
  lists?: PrInboxState;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
}

function validListPrs(state?: PrListState): OpenPr[] {
  return Array.isArray(state?.prs)
    ? state.prs.filter((pr) => pr && typeof pr.repo === 'string' && pr.repo.trim() && Number.isSafeInteger(pr.number) && pr.number > 0)
    : [];
}

function slackReviewButton(repo: string, number: number): string {
  return `<span class="slack-review-control" data-slack-review-control data-repo="${esc(repo)}" data-number="${number}">
    <button type="button" class="slack-review-request" data-slack-review-request data-repo="${esc(repo)}" data-number="${number}">Request review in Slack</button>
    <span class="slack-review-result" role="status"></span>
  </span>`;
}

function renderPrList(state: PrListState | undefined, emptyMessage: string, requestReview: boolean = false): string {
  const prs: OpenPr[] = validListPrs(state);
  const rows: string = prs.map((pr) => {
    const chip = reviewChip(pr.reviewDecision ?? '');
    const title: string = typeof pr.title === 'string' ? pr.title : 'Untitled pull request';
    return `<li class="lane pr-list-row" data-repo="${esc(pr.repo)}" data-number="${pr.number}" role="button" tabindex="0" aria-label="Open ${esc(pr.repo)} PR #${pr.number}: ${esc(title)}">
      <a class="ticket-id mono app-link" href="${esc(routeHref({ view: 'prs', repo: pr.repo, pr: pr.number, pane: 'lookup' }))}">#${pr.number}</a>
      <span class="pr-list-summary"><span class="queue-title">${esc(title)}</span><span class="agent-repo mono">${esc(pr.repo)}</span></span>
      ${pr.draft ? '<span class="chip chip-queued">Draft</span>' : ''}
      ${pr.reviewDecision ? `<span class="chip ${chip.cls}">${chip.label}</span>` : ''}
      ${requestReview ? slackReviewButton(pr.repo, pr.number) : ''}
    </li>`;
  }).join('');
  const status: string = !state || state.loading
    ? 'Loading PRs…'
    : state.degraded
      ? prs.length
        ? 'Some GitHub results are unavailable. This list may be incomplete.'
        : 'GitHub PRs are unavailable. Retrying shortly.'
      : prs.length === 0
        ? state.truncated ? 'No matching PRs in the retrieved results.' : emptyMessage
        : '';
  return `<ul class="pr-list lane-list" aria-busy="${!state || state.loading}">${rows}</ul>
    ${status ? `<div class="empty-note" role="status">${esc(status)}</div>` : ''}
    ${state?.truncated ? '<div class="empty-note pr-list-truncated">Showing the most recent results. More PRs may be available on GitHub.</div>' : ''}`;
}

function scopeRepoPrs(repo: string | null, state?: PrListState): PrListState | undefined {
  return repo && state
    ? { ...state, prs: validListPrs(state).filter((pr) => pr.repo === repo) }
    : undefined;
}

export function renderRepoPrs(repo: string | null, state?: PrListState): string {
  if (!repo) return '<div class="empty-note">Select a repository to see its open PRs.</div>';
  const repoUrl: string = `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/pulls`;
  return `${renderPrList(scopeRepoPrs(repo, state), 'No open pull requests in this repository.')}
    ${state?.truncated ? `<div class="empty-note">${githubPrListLink(repoUrl)}</div>` : ''}`;
}

function githubPrListLink(url: string): string {
  return `<a class="pr-list-github" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View all on GitHub ↗</a>`;
}

function renderPrListPanel(title: string, className: string, state: PrListState | undefined, emptyMessage: string, githubUrl: string): string {
  return `<section class="panel pr-list-panel ${className}">
    <div class="panel-head"><span class="panel-title">${title}</span><span class="mono pr-list-count">${validListPrs(state).length}</span></div>
    ${renderPrList(state, emptyMessage, className === 'pr-authored')}
    <div class="empty-note">${githubPrListLink(githubUrl)}</div>
  </section>`;
}

export function renderPrLists(lists?: PrInboxState): string {
  return `${renderPrListPanel('Review requests', 'pr-review-requests', lists?.reviewRequests, 'No PRs awaiting your review.', 'https://github.com/pulls/review-requested')}
    ${renderPrListPanel('My open PRs', 'pr-authored', lists?.authored, 'You have no open pull requests.', 'https://github.com/pulls')}`;
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

export function renderPrDiff(files: PrFileDiff[] | null): string {
  if (files === null) return '';
  if (files.length === 0) return '<div class="empty-note">No file changes in this PR.</div>';
  const fileBlocks: string = files.map((f) => {
    const body: string = f.patch
      ? `<pre class="diff-patch">${f.patch.split('\n').map((l) => `<span class="diff-line ${diffLineClass(l)}">${esc(l)}</span>`).join('\n')}</pre>`
      : '<div class="empty-note diff-nopatch">No inline diff (binary or too large).</div>';
    return `
      <details class="diff-file">
        <summary class="diff-file-head">
          <span class="diff-file-name mono">${esc(f.filename)}</span>
          <span class="diff-file-stat mono"><span class="diff-add">+${f.additions}</span> <span class="diff-del">-${f.deletions}</span></span>
        </summary>
        ${body}
      </details>`;
  }).join('');
  return `<div class="pr-diff">${fileBlocks}</div>`;
}

export function renderVoyage(run: RunSummary, now: Date = new Date()): string {
  const title = typeof run.ticketId === 'string' && run.ticketId ? run.ticketId : 'Freeform voyage';
  const hasPr = Number.isSafeInteger(run.prNumber) && (run.prNumber ?? 0) > 0;
  const label = hasPr ? `${/^review$/i.test(title) ? '' : `${title} · `}PR #${run.prNumber}` : title;
  const startedAt = typeof run.startedAt === 'string' && Number.isFinite(Date.parse(run.startedAt))
    ? `<time class="agent-elapsed mono" datetime="${esc(run.startedAt)}" title="${esc(new Date(run.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(formatRelativeTime(run.startedAt, now))}</time>` : '';
  const href = `/runs?${new URLSearchParams({ run: run.id })}`;
  return `<li class="recent-run voyage-history-row" data-runid="${esc(run.id)}">
    <a class="app-link runs-voyage-link" href="${esc(href)}">
      ${renderVoyageResult(run)}
      <span class="voyage-identity"><span class="ticket-id">${esc(label)}</span><span class="agent-repo mono" title="${esc(run.repo)}">${esc(run.repo.split('/').pop() ?? run.repo)}</span></span>
    </a>
    <div class="voyage-row-meta">
      ${run.status === 'failed' ? renderVoyageRetry(run.id, true) : ''}
      ${startedAt}
      ${renderVoyageId(run.id)}
    </div>
  </li>`;
}

export function renderRecentPrRuns(runs: RunSummary[], repo: string | null): string {
  const matches = (Array.isArray(runs) ? runs : [])
    .filter(run => run && typeof run.id === 'string' && run.id && typeof run.repo === 'string'
      && Number.isSafeInteger(run.prNumber) && (run.prNumber ?? 0) > 0 && (!repo || run.repo === repo))
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const recent = matches.slice(0, 10);
  return `<section class="panel pr-recent-runs">
    <div class="panel-head"><span class="panel-title">Recent PR voyages</span>
      <span class="panel-count mono">${recent.length}${matches.length > recent.length ? ` of ${matches.length}` : ''}</span>
      <a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo, pane: 'recent' }))}">All voyages ↗</a>
    </div>
    <ul class="recent-runs-list lane-list">${recent.length ? recent.map(run => renderVoyage(run)).join('') : '<li class="empty-note">No recent PR voyages for this repository scope.</li>'}</ul>
  </section>`;
}

export function renderPrView(state: PrViewState, opts: PrViewOpts): string {
  const value: string = state.repo && state.number ? `${state.repo}#${state.number}` : '';
  const canRerun: boolean = Boolean(state.pr && opts.repos.includes(state.pr.repo));
  const panel: string = state.loading
    ? '<div class="pr-panel empty-note">Loading PR…</div>'
    : state.number
      ? renderPrPanel(state.pr, canRerun)
      : '<div class="pr-panel empty-note">Enter a PR above to review it.</div>';
  const diffSection: string = state.pr && !state.loading
    ? `<section class="panel pr-diff-panel">
        <div class="panel-head"><span class="panel-title">Diff</span></div>
        ${renderPrDiff(state.diff)}
      </section>`
    : '';
  return renderAppShell({ active: 'prs', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      <div class="pr-inbox pr-inbox-grid">${renderPrLists(opts.lists)}</div>
      ${renderRecentPrRuns(opts.runs ?? [], opts.selectedRepo)}
      <section class="panel pr-lookup-panel">
        <div class="panel-head"><span class="panel-title">Review a PR</span></div>
        <div class="pr-lookup-form">
          <input class="pr-lookup-input" placeholder="Paste a PR URL or owner/repo#number" value="${esc(value)}" />
          <button class="pr-lookup-go">Load PR</button>
        </div>
        <div class="pr-lookup-result">${panel}</div>
      </section>
      ${diffSection}
      <div class="runs-drawer-slot"></div>
`);
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

function triageLaunchAction(ticket: Ticket, launchRepo: string | null): string {
  return launchRepo
    ? `<button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(launchRepo)}" aria-label="Launch voyage for ${esc(ticket.id)}">Launch</button>`
    : '';
}

function triageLaunchRow(ticket: Ticket, jiraBaseUrl: string | null, launchRepo: string | null): string {
  return `
      <li class="lane triage-row">
        <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
        <span class="queue-title">${esc(ticket.title)}</span>
        <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        ${triageLaunchAction(ticket, launchRepo)}
      </li>`;
}

function triageStatusRow(ticket: Ticket, jiraBaseUrl: string | null, launchRepo: string | null): string {
  return `
      <li class="lane triage-row">
        <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
        <span class="queue-title">${esc(ticket.title)}</span>
        <span class="chip ${STATUS_CHIP_CLASS[ticket.status]}">${STATUS_LABEL[ticket.status]}</span>
        <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        ${triageLaunchAction(ticket, launchRepo)}
      </li>`;
}

function triageGroup(
  title: string,
  column: TriageColumn,
  pagination: ReturnType<typeof paginateTriageTickets>,
  row: (t: Ticket, base: string | null) => string,
  jiraBaseUrl: string | null,
  emptyNote: string,
  hint: string = '',
  panelId: string = '',
  collapsed: boolean = false,
): string {
  const { tickets, total, start, end, page, pages } = pagination;
  const items: string = tickets.length
    ? tickets.map((t) => row(t, jiraBaseUrl)).join('')
    : `<li class="empty-note">${esc(emptyNote)}</li>`;
  const hintEl: string = hint && tickets.length ? `<div class="triage-hint">${esc(hint)}</div>` : '';
  return `
        <div class="panel triage-group${collapsed ? ' is-collapsed' : ''}" data-triage-column="${column}">
          <div class="panel-head">
            <span class="panel-title">${esc(title)}</span>
            <span class="panel-count mono">${total}</span>
            ${surfaceCollapseBtn(panelId, title, collapsed)}
          </div>
          ${hintEl}
          <ul class="lane-list triage-list">${items}</ul>
          <div class="triage-pagination" data-triage-column="${column}" tabindex="-1">
            <span class="triage-page-range mono" role="status" aria-label="${esc(title)} ticket range">${total ? `${start}–${end} of ${total}` : '0 of 0'}</span>
            <div class="triage-page-controls">
              <button data-triage-column="${column}" data-triage-page="${Math.max(1, page - 1)}" aria-label="Previous page for ${esc(title)}"${page <= 1 ? ' disabled' : ''}>Previous</button>
              <span class="triage-page-number mono">Page ${page} of ${pages}</span>
              <button data-triage-column="${column}" data-triage-page="${Math.min(pages, page + 1)}" aria-label="Next page for ${esc(title)}"${page >= pages ? ' disabled' : ''}>Next</button>
            </div>
          </div>
        </div>`;
}

export interface TriageViewOpts {
  repos: string[];
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
  degraded: boolean;
  themeId: string;
  collapsed?: Set<string>;
  filters?: TriageFilters;
  pageSize?: TriagePageSize;
  pages?: Partial<TriagePages>;
}

export function renderTriageView(groups: TriageGroupsView, opts: TriageViewOpts): string {
  const { repos, selectedRepo, jiraBaseUrl, degraded, themeId } = opts;
  const collapsed: Set<string> = opts.collapsed ?? new Set();
  const banner: string = degraded
    ? '<div class="degraded-banner">Jira unavailable — triage is empty.</div>'
    : '';
  const launchable: boolean = selectedRepo !== null;
  const launchRow = (t: Ticket, base: string | null): string => triageLaunchRow(t, base, selectedRepo);
  const statusRow = (t: Ticket, base: string | null): string => triageStatusRow(t, base, selectedRepo);
  const scopeHint: string = launchable ? '' : 'Select a repo to launch a voyage.';
  const filters = opts.filters ?? defaultTriageFilters();
  const pageSize = TRIAGE_PAGE_SIZES.find(size => size === opts.pageSize) ?? DEFAULT_TRIAGE_PAGE_SIZE;
  const now = Date.now();
  const filtered = {
    unassignedBacklog: filterTriageTickets(groups?.unassignedBacklog, filters, now),
    unassignedTodo: filterTriageTickets(groups?.unassignedTodo, filters, now),
    mineOpen: filterTriageTickets(groups?.mineOpen, filters, now),
  };
  const isFiltered = filters.priorities.length !== TRIAGE_PRIORITIES.length || filters.days !== 0;
  const filterEmpty = 'No tickets match these filters.';
  const capped = [groups?.unassignedBacklog, groups?.unassignedTodo, groups?.mineOpen].some(tickets => (tickets?.length ?? 0) >= 100);
  return renderAppShell({ active: 'triage', repos, selectedRepo, themeId, readout: null }, `
      ${banner}
      <div class="panel triage-filters" role="group" aria-label="Filter all triage columns">
        <fieldset class="triage-priorities"><legend>Priority</legend>
          ${TRIAGE_PRIORITIES.map(priority => `<label class="triage-priority"><input type="checkbox" data-triage-priority="${priority}"${filters.priorities.includes(priority) ? ' checked' : ''} /><span class="pri-chip ${PRIORITY_CLASS[priority]}">${priority}</span></label>`).join('')}
        </fieldset>
        <label class="triage-date">Last updated <select data-triage-days>${TRIAGE_DATE_OPTIONS.map(days => `<option value="${days}"${filters.days === days ? ' selected' : ''}>${days ? `Last ${days} ${days === 1 ? 'day' : 'days'}` : 'Any time'}</option>`).join('')}</select></label>
        <label class="triage-page-size">Tickets per column <select data-triage-page-size>${TRIAGE_PAGE_SIZES.map(size => `<option value="${size}"${pageSize === size ? ' selected' : ''}>${size}</option>`).join('')}</select></label>
      </div>
      ${capped ? '<div class="triage-hint">Filters apply to loaded tickets. Jira returns up to 100 tickets per column.</div>' : ''}
      <div class="triage-grid">
        ${triageGroup('Unassigned · Backlog', 'backlog', paginateTriageTickets(filtered.unassignedBacklog, pageSize, opts.pages?.backlog ?? 1), launchRow, jiraBaseUrl, isFiltered ? filterEmpty : 'No unassigned backlog tickets.', scopeHint, 'triage:backlog', collapsed.has('triage:backlog'))}
        ${triageGroup('Unassigned · To Do', 'todo', paginateTriageTickets(filtered.unassignedTodo, pageSize, opts.pages?.todo ?? 1), launchRow, jiraBaseUrl, isFiltered ? filterEmpty : 'No unassigned to-do tickets.', scopeHint, 'triage:todo', collapsed.has('triage:todo'))}
        ${triageGroup('Mine · underway', 'mine', paginateTriageTickets(filtered.mineOpen, pageSize, opts.pages?.mine ?? 1), statusRow, jiraBaseUrl, isFiltered ? filterEmpty : 'No unfinished tickets assigned to you.', scopeHint, 'triage:mine', collapsed.has('triage:mine'))}
      </div>
      <div class="runs-drawer-slot"></div>
`);
}

export interface BugsViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
}

function bugChip(text: string, cls: string): string {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function bugPriorityClass(priority: string | null | undefined): string {
  const level = priority?.trim().match(/^P([0-4])\b/i)?.[1];
  return level ? `pri-p${level}` : 'chip-queued';
}

function bugCardHtml(card: BugCard): string {
  if (card.degraded) {
    return `<section class="panel bug-card"><div class="panel-head"><span class="panel-title">${esc(card.label)}</span></div><div class="empty-note">Jira unavailable for ${esc(card.project)}.</div></section>`;
  }
  const deltaStr: string = card.delta > 0 ? `+${card.delta}` : String(card.delta);
  const oldest: string = card.oldest
    ? `${ticketLabel(card.oldest.key, card.jiraBaseUrl)} · ${card.oldest.ageDays}d`
    : '—';
  const p75: string = card.p75.days === null ? '—' : `${card.p75.days}d`;
  const n: string = card.p75.capped ? `${card.p75.n}+` : String(card.p75.n);
  const rows: string = card.rows.length
    ? card.rows.map((r) => `
        <tr class="bug-row">
          <td class="bug-key">${ticketLabel(r.key, card.jiraBaseUrl)}</td>
          <td class="bug-title">${esc(r.title)}</td>
          <td>${bugChip(r.priority, bugPriorityClass(r.priority))}</td>
          <td>${bugChip(r.severity, 'chip-queued')}</td>
          <td><span class="chip bug-sla ${r.sla.overdue ? 'chip-blocked' : 'chip-review'}">${esc(r.sla.text)}</span></td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="empty-note">No open bugs.</td></tr>';
  const jiraSearch: string = card.jiraBaseUrl
    ? `<a class="bug-jira-link" href="${esc(card.jiraBaseUrl)}/issues/?jql=${encodeURIComponent(`project = "${card.project}" AND issuetype = Bug AND statusCategory != Done`)}" target="_blank" rel="noopener">View all in Jira ↗</a>`
    : '';
  return `
    <section class="panel bug-card">
      <div class="panel-head bug-card-head">
        <span class="bug-squad chip chip-queued">${esc(card.label)}</span>
        <span class="panel-title">${card.open} Open bugs</span>
      </div>
      <div class="bug-stats mono">
        <span class="bug-stat"><b>${card.open}</b> Open <em>(${deltaStr} vs prior)</em></span>
        <span class="bug-stat"><b>${card.completed}</b> Completed</span>
        <span class="bug-stat"><b class="${card.pastSla > 0 ? 'bug-bad' : ''}">${card.pastSla}</b> Past SLA</span>
        <span class="bug-stat">Oldest open ${oldest}</span>
        <span class="bug-stat">P75 · ${p75} <em>(n=${n})</em></span>
      </div>
      <table class="bug-table">
        <thead><tr><th>Key</th><th>Title</th><th>Priority</th><th>Severity</th><th>SLA</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${jiraSearch}
    </section>`;
}

const GENERATED_AT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/;

function formatGeneratedAt(generatedAt: string): string {
  if (generatedAt === '') return 'Generated —';
  const m = GENERATED_AT_RE.exec(generatedAt);
  if (!m) return `Generated ${esc(generatedAt)}`;
  return `Generated ${m[1]} ${m[2]} UTC`;
}

export function renderBugsView(res: BugsResponse, opts: BugsViewOpts): string {
  const banner: string = res.degraded
    ? '<div class="degraded-banner">Jira unavailable — bug data is empty.</div>'
    : '';
  const cards: string = res.cards.map(bugCardHtml).join('');
  const bugsBody: string =
    res.cards.length === 0 && !res.degraded
      ? '<div class="empty-note">No bug data for this scope.</div>'
      : `<div class="bugs-grid">${cards}</div>`;
  return renderAppShell({ active: 'bugs', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      <div class="bugs-windows mono">
        <span>LATEST 7 DAYS · ${esc(res.latestWindow)}</span>
        <span>PREVIOUS 7 DAYS · ${esc(res.previousWindow)}</span>
        <span>${formatGeneratedAt(res.generatedAt)}</span>
      </div>
      ${banner}
      ${bugsBody}
`);
}

export interface ConfigViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  localGit?: LocalGitState;
}

function configRowsHtml(uiConfig: UiConfig): string {
  const entries: [string, unknown][] = Object.entries(uiConfig.config ?? {})
    .filter(([key]) => !['JIRA_ENABLED', 'SLACK_REVIEW_CHANNEL', 'SLACK_REVIEW_MENTION'].includes(key) && !PRE_PR_CONFIG_KEYS.some((reviewKey) => reviewKey === key));
  if (entries.length === 0) return '<div class="empty-note">No configuration keys.</div>';
  return entries
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
    .join('');
}

function prePrConfigPanel(uiConfig: UiConfig): string {
  const labels = {
    reviewerCount: 'Reviewers per round',
    maxRounds: 'Maximum review rounds',
    stageTimeoutMinutes: 'Session timeout (minutes)',
  };
  const rows = PRE_PR_SETTING_DEFINITIONS.map(({ key, envKey, defaultValue, min, max }) => {
    const value = uiConfig.config?.[envKey] ?? defaultValue;
    const isOverridden = uiConfig.overridden?.includes(envKey) ?? false;
    return `
      <div class="config-row" data-key="${envKey}">
        <label class="config-key" for="config-${envKey}">${labels[key]}${isOverridden ? ' <span class="config-overridden">(overridden)</span>' : ''}</label>
        <input id="config-${envKey}" class="config-input" type="number" min="${min}" max="${max}" step="1" required value="${esc(String(value))}" aria-describedby="help-${envKey}">
        <button class="config-save" data-key="${envKey}">Save</button>
        <span class="config-error" role="alert"></span>
      </div>
      <div class="config-warning" id="help-${envKey}">${esc(CONFIG_HELP[envKey] ?? '')} Range: ${min}–${max}; default: ${defaultValue}. <span class="mono">${envKey}</span></div>`;
  }).join('');
  return `
      <section class="panel config-panel pre-pr-config-panel" aria-labelledby="pre-pr-config-title">
        <div class="panel-head"><span class="panel-title" id="pre-pr-config-title">Pre-PR review</span></div>
        <div class="config-warning">Adversarial reviews run before a new coding voyage publishes its PR. Every reviewer must approve the final commit. Changes apply to newly launched voyages; running voyages keep their settings. Supported CLIs: Codex and Claude Code. With only one installed, one reviewer runs.</div>
        <div class="config-list">${rows}</div>
      </section>`;
}

function jiraTokenRowHtml(tokenSet: boolean): string {
  const status: string = tokenSet
    ? '<span class="config-secret-status is-set">set ✓</span>'
    : '<span class="config-secret-status is-unset">not set</span>';
  return `
      <div class="config-row config-secret-row" data-key="JIRA_API_TOKEN">
        <span class="config-key mono">JIRA_API_TOKEN ${status}<span class="config-hint" tabindex="0" role="img" aria-label="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed." title="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed.">${ICON_INFO}</span></span>
        <input class="config-input config-secret-input" type="password" autocomplete="off" placeholder="Paste new token to update">
        <button class="config-save" data-key="JIRA_API_TOKEN">Update</button>
        <span class="config-error" role="alert"></span>
      </div>`;
}

export function renderConfigView(uiConfig: UiConfig, opts: ConfigViewOpts): string {
  const jiraEnabled = uiConfig.config?.JIRA_ENABLED !== 'false' && uiConfig.config?.JIRA_ENABLED !== false;
  const themeOptions = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === opts.themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');
  return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      <section class="panel config-panel" aria-labelledby="work-source-title">
        <div class="panel-head"><span class="panel-title" id="work-source-title">Voyage source</span></div>
        <div class="config-list">
          <div class="config-row" data-key="JIRA_ENABLED">
            <label class="config-key" for="jira-enabled">Jira integration</label>
            <select class="config-input" id="jira-enabled" aria-describedby="jira-enabled-help">
              <option value="true"${jiraEnabled ? ' selected' : ''}>Enabled — Jira tickets</option>
              <option value="false"${jiraEnabled ? '' : ' selected'}>Disabled — local todos</option>
            </select>
            <button type="button" class="config-save" data-key="JIRA_ENABLED">Save</button>
            <span class="config-error" role="alert"></span>
          </div>
        </div>
        <p class="config-warning" id="jira-enabled-help">Disabling Jira replaces Triage and Bugs with Todos. The backlog and auto-claim use local todos. Saved credentials and todos are kept when switching sources.</p>
        ${jiraEnabled ? '' : `<p class="config-warning"><a class="app-link" href="${esc(routeHref({ view: 'todos', repo: opts.selectedRepo }))}">Manage todos →</a></p>`}
      </section>
      <section class="panel config-panel ui-customization-panel" aria-labelledby="ui-customization-title">
        <div class="panel-head"><span class="panel-title" id="ui-customization-title">UI customization</span></div>
        <div class="ui-customization-body">
          <label for="ui-theme">Theme</label>
          <select id="ui-theme" class="theme-select" aria-describedby="ui-theme-help">${themeOptions}</select>
          <p id="ui-theme-help">Applies immediately and is saved in this browser.</p>
          ${renderThemePreview()}
        </div>
      </section>
      <section class="panel config-panel slack-review-config" aria-labelledby="slack-review-config-title">
        <div class="panel-head"><span class="panel-title" id="slack-review-config-title">Slack review requests</span></div>
        <p class="config-warning">The button on your open PRs posts the PR link and tags your review group. Requests are sent only when you click it.</p>
        <div class="config-list">
          ${[['SLACK_REVIEW_CHANNEL', 'Channel', 'airo-editing'], ['SLACK_REVIEW_MENTION', 'Review group', 'airo-editing-squad']].map(([key, label, fallback]) => `
            <div class="config-row" data-key="${key}">
              <label class="config-key" for="config-${key}">${label}</label>
              <input id="config-${key}" class="config-input" value="${esc(String(uiConfig.config?.[key] ?? fallback))}" aria-describedby="slack-review-setup">
              <button class="config-save" data-key="${key}">Save</button><span class="config-error" role="alert"></span>
            </div>`).join('')}
          <div class="config-row config-secret-row" data-key="SLACK_BOT_TOKEN">
            <label class="config-key" for="config-SLACK_BOT_TOKEN">Bot token <span class="config-secret-status ${uiConfig.slackTokenSet ? 'is-set' : 'is-unset'}">${uiConfig.slackTokenSet ? 'set ✓' : 'not set'}</span></label>
            <input id="config-SLACK_BOT_TOKEN" class="config-input config-secret-input" type="password" autocomplete="off" placeholder="Paste bot token to update" aria-describedby="slack-review-setup">
            <button class="config-save" data-key="SLACK_BOT_TOKEN">Update</button><span class="config-error" role="alert"></span>
          </div>
        </div>
        <p class="config-warning" id="slack-review-setup">Install a Slack app with chat:write, channels:read, and usergroups:read permissions, then invite its bot to the channel. Channel and group names or IDs are accepted. For a private channel, use its ID and add groups:read. The saved token is never displayed.</p>
      </section>
      ${renderLocalGit(opts.localGit ?? emptyLocalGit(opts.selectedRepo))}
      <section class="panel config-panel">
        <div class="panel-head"><span class="panel-title">Config</span></div>
        <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
        <div class="config-list">
          ${jiraTokenRowHtml(uiConfig.jiraTokenSet === true)}
          ${configRowsHtml(uiConfig)}
        </div>
      </section>
      ${prePrConfigPanel(uiConfig)}
`);
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
  const opts: HelmHeadOpts = {
    active: 'cmux',
    repos: state.repos,
    selectedRepo: state.selectedRepo,
    themeId: state.themeId,
    readout: null,
  };
  if (!state.connected) {
    return renderAppShell(opts, '<div class="panel empty-note">Terminal not connected. Check that your terminal app is running.</div>');
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
    : '<div class="empty-note">No terminal tabs.</div>';

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
  return renderAppShell(opts, `
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
`);
}
