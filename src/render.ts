import { term, isPirateMode, TERMINOLOGY, TERMINOLOGY_REFERENCE_KEYS } from './logic/terminology';
import { renderLocalGit } from './renderLocalGit';
import { renderThemePreview } from './renderThemePreview';
import { emptyLocalGit, type LocalGitState } from './data/localGit';
import { routeHref, type PageView } from './logic/routes';
import type { PrInboxState, PrListState } from './data/prLists';
import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { resolveUnderwayTarget, type UnderwayOptions } from './logic/underway';
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
      <label class="interface-field">Model<select class="${prefix}-model tuning-select" aria-label="Model">${opts(MODEL_OPTIONS, defaultModel)}</select></label>
      <label class="interface-field">Reasoning effort<select class="${prefix}-effort tuning-select" aria-label="Reasoning effort">${opts(EFFORT_OPTIONS, defaultEffort)}</select></label>
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
  get JIRA_ENABLED() { return `Use Jira tickets for ${term('runs').toLowerCase()}; disable to use local todos instead. Applies immediately. Example: false`; },
  GITHUB_REVIEW_WATCH_ENABLED: 'Automatically review GitHub PRs requesting your review every five minutes: true or false. Changes apply immediately. Example: true',
  SLACK_ENABLED: 'Turn Slack integration on or off. Disables automatic reviews and manual requests without clearing settings. Example: true',
  SLACK_WATCH_ENABLED: 'Enable automatic PR reviews from the watched Slack channel: true or false. Changes apply immediately. Example: true',
  SLACK_CLIENT_ID: 'Slack client route context from the signed-in browser URL: the value after /client/. Example: T0123456789',
  SLACK_CHANNEL_ID: 'Exact Slack channel ID to watch. Only messages matching this channel are eligible for automatic review. Example: C0123456789',
  SLACK_CHANNEL_NAME: 'Channel name used in the Slack search query, without #. Example: pr-reviews',
  SLACK_BROWSER: 'Browser containing signed-in Slack: firefox or cmux. Example: firefox.',
  SLACK_FIREFOX_WEBDRIVER_URL: 'Local Firefox bridge address. Example: http://127.0.0.1:4444',
  SLACK_BROWSER_SURFACE: 'Optional tab reference containing signed-in Slack. Leave empty to discover the matching tab. Example: surface:17',
  SLACK_REVIEW_CHANNEL: 'Slack channel for manual PR review requests. Use a channel name or ID. Example: airo-editing',
  SLACK_REVIEW_MENTION: 'Slack user group handle to mention in manual PR review requests. Example: airo-editing-squad',
  AGENT_ADAPTER: "Which agent runs tasks: 'codex' (default), 'claude-code', or 'command' (runs your custom AGENT_CMD). Example: codex",
  AGENT_CMD: 'Shell command for the "command" adapter, run no-shell (argv only). Placeholders {ticket} {repo} {title} are substituted, then it receives the task prompt. Example: my-agent --repo {repo} --ticket {ticket}',
  get AGENT_MAX_ATTEMPTS() { return `Total attempts for existing-PR ${term('runs').toLowerCase()}, including the initial attempt. New coding ${term('runs').toLowerCase()} use the separate pre-PR review rounds. Example: 1`; },
  get AGENT_MAX_COST_USD() { return `Per-${term('run').toLowerCase()} spend ceiling in USD; the ${term('run').toLowerCase()} stops once exceeded. Blank means no cap. Example: 5.00`; },
  PRE_PR_REVIEWER_COUNT: 'Independent reviewer sessions per round: 1 uses the writer\'s CLI; 2 also uses the other supported CLI when installed. An installed reviewer that fails blocks publication. Example: 2',
  PRE_PR_MAX_ROUNDS: 'Maximum review rounds, including the initial review. Each additional round allows fixes followed by every reviewer reviewing again. Unresolved findings block the PR. Example: 3',
  PRE_PR_STAGE_TIMEOUT_MINUTES: 'Time limit in minutes for each implementation, fix, or reviewer session. A timed-out session blocks publication and retains the worktree. Example: 45',
  AUTO_CLAIM_INTERVAL_MS: 'How often (milliseconds) the auto-claim scheduler polls for backlog tickets. Interval changes apply on restart. Example: 60000',
  get REPO_PROJECT_MAP() { return `Comma-separated ${term('repository').toLowerCase()}=jiraProject pairs, mapping each ${term('repository').toLowerCase()} to the Jira project its tickets live in. Example: gdcorp-partners/airo-app-builder=AIROBUILD,gdcorp-enm/conversations-web=LEKA`; },
  get JIRA_PROJECT() { return `Default Jira project for All ${term('repositories').toLowerCase()}. Map individual ${term('repositories').toLowerCase()} with REPO_PROJECT_MAP. Example: AIROBUILD`; },
  JIRA_ASSIGNEE: 'Jira account that claimed tickets are assigned to — currentUser() or an accountId. Example: currentUser()',
  JIRA_JQL: 'Optional JQL filter that narrows which tickets appear in the backlog queue. Example: labels = agent-ready AND priority >= High',
  get GITHUB_REPO() { return `Default ${term('repository').toLowerCase()} (owner/name) used for GitHub PR lookups when none is otherwise provided. Example: gdcorp-partners/airo-app-builder`; },
  get GITHUB_PR_AUTHOR() { return `GitHub username whose authored PRs populate the ${term('shipped')} and ${term('activity')} panels. Example: nloehlein-godaddy`; },
};

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { get label() { return term('inReview'); }, chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
  closed: { label: 'Closed', chipClass: 'chip-closed' },
}

function reviewChip(decision: string): { cls: string; label: string } {
  if (decision === 'APPROVED') return { cls: 'chip-done', label: 'Approved' };
  if (decision === 'CHANGES_REQUESTED') return { cls: 'chip-blocked', label: 'Changes requested' };
  return { cls: 'chip-review', label: term('review') };
}

const ICON_LOCK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V5.1a2.5 2.5 0 0 1 5 0V7"/></svg>'

const ICON_PIRATE_FLAG = '<svg viewBox="0 0 36 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 4v32M5 8c9-7 17 7 26 0v21c-9 7-17-7-26 0"/><path d="M17 11.5c-3 0-4.5 1.8-4.5 4.2 0 1.5.8 2.8 2.1 3.4v2h4.8v-2c1.3-.6 2.1-1.9 2.1-3.4 0-2.4-1.5-4.2-4.5-4.2Z"/><circle cx="15.1" cy="16" r=".7" fill="currentColor" stroke="none"/><circle cx="18.9" cy="16" r=".7" fill="currentColor" stroke="none"/><path d="m16.2 18.5.8-1 .8 1M17 19.8v1.3m-5 2.1 10 4m0-4-10 4m-1-4.7 1 .7-.3 1.1m10.3 2.2 1 .7-.3 1.1m-.7-5.8-1 .7.3 1.1m-10.3 2.2-1 .7.3 1.1"/></svg>';

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

const ICON_COMMENT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5h-11v8h3v3l3-3h5z"/></svg>';

const ICON_REVIEW_PENDING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>';

export function renderVoyageResult(run: RunSummary): string {
  const results: Record<string, { label: string; tone: string; icon: string }> = {
    APPROVE: { label: `${term('review')} recommendation: Approve`, tone: 'approved', icon: ICON_CHECK },
    REQUEST_CHANGES: { label: `${term('review')} recommendation: Request changes`, tone: 'changes', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v8m0-4h4a3 3 0 0 0 3-3V4"/><circle cx="5" cy="2.5" r="1.5"/><circle cx="5" cy="13.5" r="1.5"/><circle cx="12" cy="2.5" r="1.5"/></svg>' },
    COMMENT: { label: `${term('review')} recommendation: Comment only`, tone: 'commented', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5h-11v8h3v3l3-3h5z"/><path d="M5 5.5h6M5 7.5h4"/></svg>' },
  };
  const review = run.status === 'succeeded' && typeof run.reviewOutcome === 'string' && Object.hasOwn(results, run.reviewOutcome)
    ? results[run.reviewOutcome] : undefined;
  const result = review ?? (run.status === 'failed'
    ? { label: `${term('run')} ${term('failed').toLowerCase()}`, tone: 'failed', icon: ICON_X_MARK }
    : run.status === 'stopped'
      ? { label: `${term('run')} stopped`, tone: 'unknown', icon: ICON_STOP }
      : run.status === 'running'
        ? { label: `${term('run')} ${term('running').toLowerCase()}`, tone: 'running', icon: ICON_DOTS }
        : run.status === 'queued'
          ? { label: `${term('run')} queued`, tone: 'unknown', icon: ICON_DOTS }
          : run.status === 'succeeded'
            ? { label: term('noReviewResult'), tone: 'unknown', icon: ICON_INFO }
            : { label: `${term('run')} status: ${run.status || 'Unknown'}`, tone: 'unknown', icon: ICON_INFO });
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
         role="img" aria-label="Completed items per day, last 7 days">
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
  { view: 'dashboard', get label() { return term('dashboard'); } },
  { view: 'prs', get label() { return term('prs'); } },
  { view: 'triage', label: 'Triage' },
  { view: 'todos', label: 'Todos' },
  { view: 'cmux', label: 'Terminal' },
  { view: 'bugs', label: 'Bugs' },
  { view: 'runs', get label() { return term('runs'); } },
  { view: 'outcomes', get label() { return term('costsOutcomes'); } },
  { view: 'campaigns', get label() { return term('campaigns'); } },
  { view: 'clarifications', get label() { return term('clarifications'); } },
  { view: 'config', label: 'Config' },
];

const PANEL_TITLE: Record<PanelId, string> = {
  get newrun() { return term('newRun'); },
  backlog: 'Backlog queue',
  get underway() { return term('mineRunning'); },
  get running() { return term('activeAgents'); },
  get recent() { return term('recentRuns'); },
  get repoprs() { return term('openPrs'); },
  get shipped() { return term('shipped'); },
  get activity() { return term('activity'); },
};

interface PanelDef {
  body: string;
  count: number | null;
  lamp: 'live' | 'queued' | 'idle';
}

export interface HelmHeadOpts {
  greetingName?: string | null;
  active: PageView;
  jiraEnabled?: boolean;
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  readout: { running: number | null; queued: number | null; review: number | null } | null;
}

export function renderHelmHead(opts: HelmHeadOpts): string {
  const sorted: string[] = [...new Set([...opts.repos, ...(opts.selectedRepo ? [opts.selectedRepo] : [])])]
    .sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)));
  const scopeOptions: string = [`<option value="">${term('allRepositories')}</option>`]
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
  const readout = `<div class="helm-readout mono" aria-label="${term('systemStatus')}">
    ${(['running', 'queued', 'review'] as const).map((key) => {
      const value = opts.readout?.[key];
      const known = typeof value === 'number' && Number.isFinite(value);
      const label = key === 'running' ? term('running').toLowerCase() : key === 'queued' ? 'queue' : term('review').toLowerCase();
      return `<span class="seg"><b class="seg7" data-fleet-count="${key}"${known ? '' : ` title="Not loaded for this ${term('repository').toLowerCase()}"`}>${known ? value : '—'}</b> <span data-readout-label="${key}">${label}</span></span>`;
    }).join('')}
  </div>`;
  return `
    <header class="helm-head">
      <div class="nameplate">
        <span class="nameplate-mark" aria-hidden="true">${HELM_EMBLEM}</span>
        <div class="nameplate-scope">
          <span class="nameplate-name">Helmsman <span class="nameplate-alpha">Alpha</span></span>
          <select class="repo-select" aria-label="${term('scopeByRepository')}">${scopeOptions}</select>
          <span class="helm-greeting" data-greeting>${term('greeting')}${typeof opts.greetingName === 'string' && opts.greetingName.trim() ? `, ${esc(opts.greetingName.trim())}` : ''}!</span>
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
      <div class="footer-meta">
        <span class="footer-attr">nloehlein@godaddy.com</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>Helmsman v${esc(__APP_VERSION__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span>updated ${esc(__BUILD_DATE__)}</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-repos>${opts.repos.length} ${term(opts.repos.length === 1 ? 'repository' : 'repositories').toLowerCase()} tracked</span>
        <span class="footer-dot" aria-hidden="true">&bull;</span><span data-footer-running>${running} ${term('running').toLowerCase()}</span>
      </div>
      <button class="pirate-mode-toggle" type="button" data-pirate-mode aria-label="Pirate mode" aria-pressed="${isPirateMode()}" title="Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}">${ICON_PIRATE_FLAG}</button>
    </footer>
  </div>`;
}

function renderRackSlot(slot: RackSlot, defs: Record<PanelId, PanelDef>, c: number, s: number): string {
  const active: PanelId = slot.active;
  const def: PanelDef = defs[active];
  const header: string =
    slot.panels.length > 1
      ? `<div class="slot-tabs" role="tablist" aria-label="Stacked panels">${slot.panels
          .map(
            (p) =>
              `<button class="slot-tab${p === active ? ' is-active' : ''}" type="button" role="tab" id="rack-tab-${c}-${s}-${p}" aria-controls="rack-panel-${c}-${s}" aria-selected="${p === active}" tabindex="${p === active ? 0 : -1}" data-panel-tab="${p}">${esc(PANEL_TITLE[p])}</button>`,
          )
          .join('')}</div>`
      : `<span class="faceplate-title">${esc(PANEL_TITLE[active])}</span>`;
  const count: string = def.count != null ? `<span class="faceplate-count seg7">${def.count}</span>` : '';
  return `
      <section class="faceplate${slot.collapsed ? ' is-collapsed' : ''}" data-col="${c}" data-slot="${s}" data-panel="${active}">
        <div class="faceplate-head" data-drop="head" data-panel="${active}">
          <button class="rack-handle" type="button" draggable="true" data-panel="${active}" aria-label="Move ${esc(PANEL_TITLE[active])}" aria-describedby="rack-move-help-${c}-${s}" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight">${ICON_GRIP}</button><span class="sr-only" id="rack-move-help-${c}-${s}">Use arrow keys to move this panel between positions or columns, or drag it.</span>
          ${header}
          <span class="faceplate-lamp lamp lamp-${def.lamp}" aria-hidden="true"></span>
          ${count}
          <button class="panel-collapse" type="button" data-panel="${active}" aria-expanded="${slot.collapsed ? 'false' : 'true'}" aria-label="${slot.collapsed ? 'Expand' : 'Collapse'} ${esc(PANEL_TITLE[active])}">${slot.collapsed ? ICON_EXPAND : ICON_COLLAPSE}</button>
        </div>
        <div class="faceplate-body" id="rack-panel-${c}-${s}"${slot.panels.length > 1 ? ` role="tabpanel" aria-labelledby="rack-tab-${c}-${s}-${active}" tabindex="0"` : ''} data-drop="body" data-col="${c}" data-slot="${s}">${def.body}</div>
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
  const scopedRuns = (Array.isArray(runs) ? runs : []).filter(run => run && typeof run.id === 'string'
    && typeof run.repo === 'string' && (!selectedRepo || run.repo === selectedRepo));
  const activeRuns: RunSummary[] = scopedRuns.filter((r) => r.status === 'running');
  const terminalRuns: RunSummary[] = scopedRuns.filter((r) => r.status !== 'running' && r.status !== 'queued')
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)).slice(0, 10);
  const underway = Array.isArray(data.underway) ? data.underway.filter(ticket => ticket && ticket.status !== 'done') : [];
  const underwayKnown = data.underwayAvailable !== false && Array.isArray(data.underway);
  const underwayItems = underwayKnown && underway.length
    ? sortByPriority(underway).map(ticket => underwayRow(ticket, jiraBaseUrl, jiraEnabled, {
      selectedRepo, runs: scopedRuns, prs: data.myOpenPrs, prsAvailable: !degraded.includes('github'),
    })).join('')
    : `<li class="empty-note">${underwayKnown ? jiraEnabled ? 'No unfinished tickets assigned to you.' : 'No todos in progress or review.' : term('unavailableRunningTickets')}</li>`;

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
        <button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="${term('launchTicket')} ${esc(ticket.id)}">${term('launchTicket')}</button>
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
        <button class="agent-stop" data-runid="${esc(run.id)}" aria-label="Stop ${term('run').toLowerCase()} ${esc(run.ticketId)}">${ICON_STOP}</button>
      </li>`,
        )
        .join('')
    : `<li class="empty-note">${term('noAgentTasks')}</li>`;

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
    .join('') || `<div class="empty-note">${term('noRecentPrs')}</div>`;

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
    ? terminalRuns.map(run => renderVoyage(run, now, selectedRepo)).join('')
    : `<li class="empty-note">${term('noRuns')}</li>`;

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
              <span>Jira ticket</span>
            </label>` : ''}
            <label class="newrun-mode-label">
              <input type="radio" class="newrun-mode" name="newrun-mode" value="freeform"${jiraEnabled ? '' : ' checked'}>
              <span>Custom task</span>
            </label>
          </div>
          <div class="newrun-fields">
            ${jiraEnabled ? `<label class="interface-field newrun-ticket-field">Jira ticket ID<input class="newrun-ticket" type="text" placeholder="ABC-123"></label>
            <label class="interface-field newrun-ticket-field">Title (optional)<input class="newrun-title" type="text" placeholder="Short task title"></label>` : ''}
            <label class="interface-field newrun-task-field">Custom task instructions<textarea class="newrun-task" placeholder="Describe the desired change, constraints, and how to verify it."></textarea></label>
            <label class="interface-field">${term('repository')}<select class="newrun-repo" aria-label="${term('repository')} for ${term('newRun').toLowerCase()}">${newRunRepoOptions}</select></label>
            ${tuningSelects('newrun')}
            <button class="newrun-launch">${term('launchRun')}</button>
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
      body: `${jiraEnabled && underwayKnown && underway.length && !selectedRepo ? `<div class="triage-hint">${term('launchScopeHint')}</div>` : ''}<ul class="underway-list lane-list">${underwayItems}</ul>`,
    },
    recent: {
      lamp: 'idle',
      count: terminalRuns.length,
      body: `<ul class="recent-runs-list lane-list">${recentRunItems}</ul><div class="runs-pagination"><a class="app-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, pane: 'recent' }))}">${term('allRuns')} →</a></div>`,
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
          <span class="throughput-label mono">Completed · last 7 days</span>
          <div class="spark-wrap">${buildSparkline(data.throughput7d)}</div>
        </div>
        <div class="feed">${activityLines}</div>`,
    },
  };

  root.innerHTML = renderAppShell({
    active: 'dashboard', repos, selectedRepo, themeId,
    readout: { running: activeRuns.length, queued: queue.length, review: data.stats.awaitingReview },
  }, `<h1 class="sr-only">Helm</h1>${banner}${renderRack(layout, panelDefs)}<div class="runs-drawer-slot"></div>`);
}

function renderVoyageId(id: unknown): string {
  const shortId = shortVoyageId(id);
  return shortId && typeof id === 'string'
    ? `<button type="button" class="voyage-id mono" data-copy-run-id="${esc(id)}" title="${esc(id)}" aria-label="Copy full ${term('run').toLowerCase()} ID ${esc(id)}">${ICON_COPY}<span>${esc(shortId)}</span><span class="voyage-copy-feedback" role="status" aria-live="polite"></span></button>`
    : '';
}

export function renderVoyageRetry(id: string, iconOnly = false): string {
  if (typeof id !== 'string' || id.startsWith('err-') || !/^[a-z\d_-]{1,128}$/i.test(id)) return '';
  return `<button type="button" class="voyage-retry" data-retry-run-id="${esc(id)}" aria-label="${term('retryRun')} ${esc(id)}" title="${term('retryRunHint')}">${ICON_REDO}<span${iconOnly ? ' class="sr-only"' : ''}>Retry</span></button><span class="voyage-retry-feedback" data-retry-feedback-for="${esc(id)}" role="status" aria-live="polite"></span>`;
}

export interface RunTabView {
  id: string;
  label: string;
  complete: boolean;
  status?: string;
}

export function runTabStatus(status?: string, complete = false): { kind: string; label: string } {
  const labels: Record<string, string> = { running: term('running'), succeeded: term('success'), failed: term('failed'), stopped: 'Stopped', queued: 'Queued', completed: 'Completed' };
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
          <div class="run-tab-actions">${!t.id.startsWith('err-') ? `<a class="run-tab-open app-link pane-link" href="${esc(routeHref({ view: 'runs', run: t.id, pane: 'tasks' }))}" aria-label="Open ${esc(t.label)} in ${term('runs')}" title="Open ${term('run').toLowerCase()}">${ICON_OPEN}</a>` : ''}
          <button class="run-tab-close" type="button" data-tabid="${esc(t.id)}" aria-label="Close ${esc(t.label)}" title="Close ${term('run').toLowerCase()}">${ICON_CLOSE}</button></div>
        </div>
      </div>`;
      },
    )
    .join('');
  const emptyBody: string =
    tabs.length === 0
      ? `<div class="run-drawer-empty empty-note">${term('noOpenTasks')}</div>`
      : '';
  const header: string =
    tabs.length === 0 ? `<span class="run-drawer-title mono">${term('agentTasks').toUpperCase()}</span>` : '';
  const collapseBtn: string =
    tabs.length > 0 ? surfaceCollapseBtn('runs:drawer', term('agentTasks').toLowerCase(), collapsed) : '';
  const activeTab = tabs.find(tab => tab.id === activeId);
  const logToolbar = activeId && !activeId.startsWith('err-') && /^[a-z\d_-]{1,128}$/i.test(activeId)
    ? `<div class="run-log-toolbar mono">${renderVoyageId(activeId)}<span>Recent output · up to ${RUN_LOG_PREVIEW_LIMIT} entries</span><a class="run-log-download" href="/api/agents/${encodeURIComponent(activeId)}/log/download" download title="Includes earlier output and full-length entries">Download full log</a></div>`
    : '';
  return `
    <div class="run-tabs" role="tablist" aria-label="Open ${term('runs').toLowerCase()}">${header}${strip}${collapseBtn}</div>
    ${logToolbar}
    <div class="run-drawer-retry">${activeTab?.status === 'failed' ? renderVoyageRetry(activeTab.id) : ''}</div>
    <div class="run-drawer-body mono" id="run-log-panel" role="tabpanel"${activeId ? ` aria-labelledby="run-tab-${esc(encodeURIComponent(activeId))}"` : ` aria-label="${term('run')} output"`} tabindex="0">${emptyBody}</div>
    <div class="run-drawer-footer mono"></div>
    <div class="run-drawer-pr"></div>`;
}

function prTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  const date = new Date(value);
  const label = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<time datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString(undefined, { timeZoneName: 'short' }))}">${esc(label)}</time>`;
}

export function renderPrPanel(pr: PrStatusView | null, canRerun: boolean, showOpenInTab: boolean = false, selectedRepo: string | null = null): string {
  if (!pr) return `<div class="pr-panel empty-note" role="status">${term('noPrFound')} Check the URL and your GitHub access, then select Load ${term('pr')} again.</div>`;
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
    ? `<span class="chip pr-viewer-review ${reviewChip(pr.viewerReview ?? '').cls}">Your ${term('review').toLowerCase()}: ${viewerReviewLabel}</span>`
    : '';
  const reviewTimeKnown = pr.reviewsAvailable !== false && typeof pr.viewerReviewedAt === 'string' && Number.isFinite(Date.parse(pr.viewerReviewedAt));
  const reviewTime = prTimestamp(reviewTimeKnown ? pr.viewerReviewedAt : undefined,
    pr.reviewsAvailable === true && !pr.viewerReview && pr.viewerReviewedAt === undefined ? term('notReviewed') : 'Unavailable');
  const canCompareCommits = reviewTimeKnown && typeof pr.headSha === 'string' && pr.headSha.trim()
    && typeof pr.viewerReviewedCommitId === 'string' && pr.viewerReviewedCommitId.trim();
  const commitChanged = canCompareCommits && pr.headSha !== pr.viewerReviewedCommitId;
  const reviewFreshness = canCompareCommits
    ? `<span class="pr-review-freshness${commitChanged ? ' chip chip-review' : ''}">${commitChanged ? 'New commits since your review' : 'You reviewed the current commit'}</span>`
    : '';
  const canRelaunch: boolean = canRerun && pr.isOwnPr === true;
  const feedback: string = canRelaunch
    ? `<label class="interface-field">Changes for the ${term('agents').toLowerCase()} to make<textarea class="pr-rerun-feedback" aria-label="Feedback for ${term('agents').toLowerCase()} to address" placeholder="Describe the changes to make on this branch."></textarea></label>`
    : '';
  const rerun: string = canRerun
    ? `<div class="pr-crew-controls">${feedback}${tuningSelects('pr')}<div class="pr-review-actions">${canRelaunch ? '<button class="pr-rerun">Update branch with feedback</button>' : ''}<button class="pr-review-agent">${term('codeReview')}</button></div><div class="pr-voyage-links"><a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, prRepo: pr.repo, pr: pr.number, pane: 'newrun', mode: 'review' }))}">Open review setup ↗</a>${canRelaunch ? `<a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, prRepo: pr.repo, pr: pr.number, pane: 'newrun', mode: 'rerun' }))}">Open branch update setup ↗</a>` : ''}</div></div>`
    : `<div class="pr-no-rerun empty-note">${term('crewUnavailable')}</div>`;
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
          ${showOpenInTab ? `<button class="pr-open-in-tab" type="button" data-repo="${esc(pr.repo)}" data-number="${pr.number}">Open in ${term('pr')} tab ↗</button>` : ''}
        </div>
        <div class="pr-panel-timing">
          <span class="pr-last-reviewed"><span class="pr-meta-label">${term('lastReviewed')}</span>${reviewTime}</span>
          <span class="pr-last-updated" title="Latest GitHub PR activity, including commits, comments, and reviews"><span class="pr-meta-label">Last updated</span>${prTimestamp(pr.updatedAt, 'Unavailable')}</span>
          ${reviewFreshness}
        </div>
      </div>
      ${pr.isOwnPr === true && pr.state === 'open' && !pr.merged ? slackReviewButton(pr.repo, pr.number) : ''}
      <div class="pr-review">
        <label class="interface-field">Your GitHub review<textarea class="pr-review-body" placeholder="Explain your approval, requested changes, or comment."></textarea></label>
        <div class="pr-review-actions">
          <button class="pr-approve">Approve</button>
          <button class="pr-request-changes">Request changes</button>
          <button class="pr-comment">Post comment</button>
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

function slackReviewButton(repo: string, number: number, unavailable: string = ''): string {
  return `<span class="slack-review-control" data-slack-review-control data-repo="${esc(repo)}" data-number="${number}"${unavailable ? ` data-unavailable="${esc(unavailable)}"` : ''}>
    <button type="button" class="slack-review-request" data-slack-review-request data-repo="${esc(repo)}" data-number="${number}"${unavailable ? ` disabled title="${esc(unavailable)}"` : ''}>${term('requestSlackReview')}</button>
    <span class="slack-review-result" role="status"></span>
  </span>`;
}

function prListStats(pr: OpenPr): { html: string; label: string } {
  const stats = [
    { key: 'comments', value: pr.comments, icon: ICON_COMMENT, label: 'comments', detail: 'Discussion and inline comments', includeZero: true },
    { key: 'approved', value: pr.reviews?.approved, icon: ICON_CHECK, label: 'approvals', detail: 'Approvals', includeZero: true },
    { key: 'changes', value: pr.reviews?.changesRequested, icon: ICON_X_MARK, label: 'changes requested', detail: 'Changes requested', includeZero: false },
    { key: 'pending', value: pr.reviews?.requested, icon: ICON_REVIEW_PENDING, label: `pending ${term('reviews').toLowerCase()}`, detail: `Pending ${term('reviews').toLowerCase()}`, includeZero: false },
  ].flatMap(stat => typeof stat.value === 'number' && Number.isSafeInteger(stat.value) && stat.value >= 0 && (stat.includeZero || stat.value > 0)
    ? [{ ...stat, value: stat.value }] : []);
  return {
    label: stats.map(stat => `${stat.label}: ${stat.value}`).join('; '),
    html: stats.length ? `<span class="pr-list-stats mono">${stats.map(stat => `<span class="pr-list-stat" data-pr-stat="${stat.key}" role="img" aria-label="${esc(stat.label)}: ${stat.value}" title="${esc(stat.detail)}: ${stat.value}">${stat.icon}<span aria-hidden="true">${stat.value}</span></span>`).join('')}</span>` : '',
  };
}

function renderPrList(state: PrListState | undefined, emptyMessage: string, requestReview: boolean = false, selectedRepo: string | null = null): string {
  const prs: OpenPr[] = validListPrs(state);
  const rows: string = prs.map((pr) => {
    const chip = reviewChip(pr.reviewDecision ?? '');
    const title: string = typeof pr.title === 'string' ? pr.title : 'Untitled pull request';
    const stats = prListStats(pr);
    return `<li class="lane pr-list-row" data-repo="${esc(pr.repo)}" data-number="${pr.number}" role="button" tabindex="0" aria-label="Open ${esc(pr.repo)} ${term('pr')} #${pr.number}: ${esc(title)}${stats.label ? `; ${esc(stats.label)}` : ''}">
      <a class="ticket-id mono app-link" href="${esc(routeHref({ view: 'prs', repo: selectedRepo, prRepo: pr.repo, pr: pr.number, pane: 'lookup' }))}">#${pr.number}</a>
      <span class="pr-list-summary"><span class="queue-title">${esc(title)}</span><span class="agent-repo mono">${esc(pr.repo)}</span>${stats.html}</span>
      ${pr.draft ? '<span class="chip chip-queued">Draft</span>' : ''}
      ${pr.reviewDecision ? `<span class="chip ${chip.cls}">${chip.label}</span>` : ''}
      ${requestReview ? slackReviewButton(pr.repo, pr.number) : ''}
    </li>`;
  }).join('');
  const status: string = !state || state.loading
    ? term('loadingPrs')
    : state.degraded
      ? prs.length
        ? 'Some GitHub results are unavailable. This list may be incomplete.'
        : term('unavailablePrs')
      : prs.length === 0
        ? state.truncated ? term('noMatchingPrs') : emptyMessage
        : '';
  return `<ul class="pr-list lane-list" aria-busy="${!state || state.loading}">${rows}</ul>
    ${status ? `<div class="empty-note" role="status">${esc(status)}</div>` : ''}
    ${state?.truncated ? `<div class="empty-note pr-list-truncated">${term('morePrs')}</div>` : ''}`;
}

function scopeRepoPrs(repo: string | null, state?: PrListState): PrListState | undefined {
  return repo && state
    ? { ...state, prs: validListPrs(state).filter((pr) => pr.repo === repo) }
    : undefined;
}

export function renderRepoPrs(repo: string | null, state?: PrListState): string {
  if (!repo) return `<div class="empty-note">${term('selectRepoPrs')}</div>`;
  const repoUrl: string = `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/pulls`;
  return `${renderPrList(scopeRepoPrs(repo, state), term('noRepoPrs'), false, repo)}
    ${state?.truncated ? `<div class="empty-note">${githubPrListLink(repoUrl)}</div>` : ''}`;
}

function githubPrListLink(url: string): string {
  return `<a class="pr-list-github" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View all on GitHub ↗</a>`;
}

function renderPrListPanel(title: string, className: string, state: PrListState | undefined, emptyMessage: string, githubUrl: string, selectedRepo: string | null): string {
  return `<section class="panel pr-list-panel ${className}">
    <div class="panel-head"><span class="panel-title">${title}</span><span class="mono pr-list-count">${validListPrs(state).length}</span></div>
    ${renderPrList(state, emptyMessage, className === 'pr-authored', selectedRepo)}
    <div class="empty-note">${githubPrListLink(githubUrl)}</div>
  </section>`;
}

export function renderPrLists(lists?: PrInboxState, selectedRepo: string | null = null): string {
  const reviewUrl = selectedRepo ? `https://github.com/pulls?q=${encodeURIComponent(`is:open is:pr review-requested:@me repo:${selectedRepo}`)}` : 'https://github.com/pulls/review-requested';
  const authoredUrl = selectedRepo ? `https://github.com/pulls?q=${encodeURIComponent(`is:open is:pr author:@me repo:${selectedRepo}`)}` : 'https://github.com/pulls';
  return `${renderPrListPanel(term('reviewRequests'), 'pr-review-requests', lists?.reviewRequests, term('noReviewRequests'), reviewUrl, selectedRepo)}
    ${renderPrListPanel(term('myOpenPrs'), 'pr-authored', lists?.authored, term('noAuthoredPrs'), authoredUrl, selectedRepo)}`;
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
      ? `<pre class="diff-patch" tabindex="0" role="region" aria-label="Diff for ${esc(f.filename)}">${f.patch.split('\n').map((l) => `<span class="diff-line ${diffLineClass(l)}">${esc(l)}</span>`).join('\n')}</pre>`
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

export function renderVoyage(run: RunSummary, now: Date = new Date(), selectedRepo: string | null = null): string {
  const title = typeof run.ticketId === 'string' && run.ticketId ? run.ticketId : term('freeformRun');
  const hasPr = Number.isSafeInteger(run.prNumber) && (run.prNumber ?? 0) > 0;
  const label = hasPr ? `${/^review$/i.test(title) ? '' : `${title} · `}${term('pr')} #${run.prNumber}` : title;
  const startedAt = typeof run.startedAt === 'string' && Number.isFinite(Date.parse(run.startedAt))
    ? `<time class="agent-elapsed mono" datetime="${esc(run.startedAt)}" title="${esc(new Date(run.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(formatRelativeTime(run.startedAt, now))}</time>` : '';
  const href = routeHref({ view: 'runs', run: run.id, repo: selectedRepo });
  return `<li class="recent-run voyage-history-row" data-runid="${esc(run.id)}">
    <div class="voyage-row-main">
      <a class="app-link runs-voyage-link" href="${esc(href)}">
        ${renderVoyageResult(run)}
        <span class="voyage-identity"><span class="ticket-id">${esc(label)}</span><span class="agent-repo mono" title="${esc(run.repo)}">${esc(run.repo.split('/').pop() ?? run.repo)}</span></span>
      </a>
      ${run.status === 'failed' ? renderVoyageRetry(run.id, true) : ''}
    </div>
    <div class="voyage-row-meta">
      ${renderVoyageId(run.id)}
      ${startedAt}
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
    <div class="panel-head"><span class="panel-title">${term('recentPrRuns')}</span>
      <span class="panel-count mono">${recent.length}${matches.length > recent.length ? ` of ${matches.length}` : ''}</span>
      <a class="app-link pane-link" href="${esc(routeHref({ view: 'runs', repo, pane: 'recent' }))}">${term('allRuns')} ↗</a>
    </div>
    <ul class="recent-runs-list lane-list">${recent.length ? recent.map(run => renderVoyage(run, undefined, repo)).join('') : `<li class="empty-note">${term('noRecentPrRuns')}</li>`}</ul>
  </section>`;
}

export function renderPrView(state: PrViewState, opts: PrViewOpts): string {
  const value: string = state.repo && state.number ? `${state.repo}#${state.number}` : '';
  const canRerun: boolean = Boolean(state.pr && opts.repos.includes(state.pr.repo));
  const panel: string = state.loading
    ? `<div class="pr-panel empty-note" role="status">${term('loadingPr')}</div>`
    : state.number
      ? renderPrPanel(state.pr, canRerun, false, opts.selectedRepo)
      : `<div class="pr-panel empty-note">${term('prLookupHint')}</div>`;
  const diffSection: string = state.pr && !state.loading
    ? `<section class="panel pr-diff-panel">
        <div class="panel-head"><span class="panel-title">Diff</span></div>
        ${renderPrDiff(state.diff)}
      </section>`
    : '';
  return renderAppShell({ active: 'prs', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      <h1 class="sr-only">${term('prs')}</h1>
      <div class="pr-inbox pr-inbox-grid">${renderPrLists(opts.lists, opts.selectedRepo)}</div>
      ${renderRecentPrRuns(opts.runs ?? [], opts.selectedRepo)}
      <section class="panel pr-lookup-panel">
        <div class="panel-head"><span class="panel-title">${term('reviewPr')}</span></div>
        <div class="pr-lookup-form">
          <label class="interface-field">${term('pr')} URL or owner/name#number<input class="pr-lookup-input" placeholder="${term('prPlaceholder')}" value="${esc(value)}" /></label>
          <button class="pr-lookup-go">Load ${term('pr')}</button>
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
  get 'in-review'() { return term('inReview'); },
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
    ? `<button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(launchRepo)}" aria-label="${term('launchTicket')} ${esc(ticket.id)}">${term('launchTicket')}</button>`
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

function underwayRow(ticket: Ticket, jiraBaseUrl: string | null, jiraEnabled: boolean, options: UnderwayOptions): string {
  const { run, prs } = resolveUnderwayTarget(ticket, options);
  const inspection = ticket.status === 'in-review';
  const pr = prs.length === 1 ? prs[0] : undefined;
  const reviewHref = (target?: { repo: string; number: number }) => routeHref({ view: 'prs', repo: options.selectedRepo,
    prRepo: target?.repo ?? null, pr: target?.number ?? null, pane: target ? 'lookup' : 'authored' });
  const href = inspection ? reviewHref(pr) : run
    ? routeHref({ view: 'runs', repo: options.selectedRepo, pane: 'tasks', run: run.id })
    : routeHref({ view: jiraEnabled ? 'runs' : 'todos', repo: options.selectedRepo, pane: jiraEnabled ? 'newrun' : 'list', ticket: ticket.id });
  const action = inspection
    ? `<span class="underway-actions">${prs.length ? prs.map(target => `<span class="underway-pr-action">
        <a class="app-link mono" href="${esc(reviewHref(target))}">${esc(options.selectedRepo ? '' : `${target.repo} `)}#${target.number}</a>
        ${slackReviewButton(target.repo, target.number, target.canRequest ? '' : 'An open, non-draft pull request authored by you must be available before requesting a review.')}
      </span>`).join('') : `<button type="button" class="slack-review-request" disabled title="Find the associated open pull request first.">${term('requestSlackReview')}</button>
        <a class="app-link" href="${esc(reviewHref())}">Find associated ${term('pr').toLowerCase()}</a>`}</span>`
    : run ? `<a class="app-link underway-open" href="${esc(href)}">Open ${term('run').toLowerCase()}</a>`
    : jiraEnabled ? triageLaunchAction(ticket, options.selectedRepo) : '';
  return `<li class="lane triage-row underway-row" role="link" tabindex="0" data-underway-href="${esc(href)}"
      aria-label="Open ${inspection ? term('review').toLowerCase() : term('run').toLowerCase()} for ${esc(ticket.id)}">
      <span class="ticket-id">${ticketLabel(ticket.id, jiraBaseUrl)}</span>
      <span class="queue-title">${esc(ticket.title)}</span>
      <span class="chip ${STATUS_CHIP_CLASS[ticket.status]}">${STATUS_LABEL[ticket.status]}</span>
      <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
      ${action}
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
    ? '<div class="degraded-banner" role="alert">Jira tickets could not be loaded. Check Jira settings in Config, then refresh this page.</div>'
    : '';
  const launchable: boolean = selectedRepo !== null;
  const launchRow = (t: Ticket, base: string | null): string => triageLaunchRow(t, base, selectedRepo);
  const statusRow = (t: Ticket, base: string | null): string => triageStatusRow(t, base, selectedRepo);
  const scopeHint: string = launchable ? '' : term('launchScopeHint');
  const filters = opts.filters ?? defaultTriageFilters();
  const pageSize = TRIAGE_PAGE_SIZES.find(size => size === opts.pageSize) ?? DEFAULT_TRIAGE_PAGE_SIZE;
  const now = Date.now();
  const filtered = {
    unassignedBacklog: filterTriageTickets(groups?.unassignedBacklog, filters, now),
    unassignedTodo: filterTriageTickets(groups?.unassignedTodo, filters, now),
    mineOpen: filterTriageTickets(groups?.mineOpen, filters, now),
  };
  const isFiltered = filters.priorities.length !== TRIAGE_PRIORITIES.length || filters.days !== 0;
  const filterEmpty = 'No tickets match these filters. Select more priorities or a wider date range.';
  const capped = [groups?.unassignedBacklog, groups?.unassignedTodo, groups?.mineOpen].some(tickets => (tickets?.length ?? 0) >= 100);
  return renderAppShell({ active: 'triage', repos, selectedRepo, themeId, readout: null }, `
      <header class="page-intro"><h1>Triage</h1><p>Choose a Jira ticket for the ${term('agents').toLowerCase()} to work on. The header ${term('repository').toLowerCase()} is the launch target.</p></header>
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
        ${triageGroup(term('mineRunning'), 'mine', paginateTriageTickets(filtered.mineOpen, pageSize, opts.pages?.mine ?? 1), statusRow, jiraBaseUrl, isFiltered ? filterEmpty : 'No unfinished tickets assigned to you.', scopeHint, 'triage:mine', collapsed.has('triage:mine'))}
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
        <span class="bug-stat"><b>${card.completed}</b> Completed · 7 days</span>
        <span class="bug-stat"><b class="${card.pastSla > 0 ? 'bug-bad' : ''}">${card.pastSla}</b> Past SLA</span>
        <span class="bug-stat">Oldest open ${oldest}</span>
        <span class="bug-stat" title="75% of sampled bugs resolved in the last 90 days were completed within this duration">Resolution time · P75 ${p75} <em>(${n} sampled)</em></span>
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
    ? '<div class="degraded-banner" role="alert">Bug data could not be loaded from Jira. Check Jira settings in Config, then refresh this page.</div>'
    : '';
  const cards: string = res.cards.map(bugCardHtml).join('');
  const bugsBody: string =
    res.cards.length === 0 && !res.degraded
      ? '<div class="empty-note">No bug data for this scope.</div>'
      : `<div class="bugs-grid">${cards}</div>`;
  return renderAppShell({ active: 'bugs', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      <header class="page-intro"><h1>Bugs</h1><p>Track open bugs and resolution times. Open a ticket in Jira to investigate or update it.</p></header>
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
  loading?: boolean;
  error?: string | null;
  unavailable?: boolean;
}

function configRowsHtml(uiConfig: UiConfig): string {
  const entries: [string, unknown][] = Object.entries(uiConfig.config ?? {})
    .filter(([key]) => key !== 'JIRA_ENABLED' && !key.startsWith('SLACK_') && !PRE_PR_CONFIG_KEYS.some((reviewKey) => reviewKey === key));
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
        <label class="config-key mono" for="config-${esc(encodeURIComponent(key))}">${esc(key)}${isOverridden ? ' <span class="config-overridden">(saved override)</span>' : ''}${hint}</label>
        <input id="config-${esc(encodeURIComponent(key))}" class="config-input" type="text" value="${esc(String(value ?? ''))}" aria-describedby="${help ? `help-${esc(encodeURIComponent(key))} ` : ''}error-${esc(encodeURIComponent(key))}">
        <button type="button" class="config-save" data-key="${esc(key)}" aria-label="Save ${esc(key)}">Save</button>
        <span class="config-error" id="error-${esc(encodeURIComponent(key))}" role="alert"></span>
        ${help ? `<span class="sr-only" id="help-${esc(encodeURIComponent(key))}">${esc(help)}</span>` : ''}
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
        <input id="config-${envKey}" class="config-input" type="number" min="${min}" max="${max}" step="1" required value="${esc(String(value))}" aria-describedby="help-${envKey} error-${envKey}">
        <button type="button" class="config-save" data-key="${envKey}" aria-label="Save ${labels[key]}">Save</button>
        <span class="config-error" id="error-${envKey}" role="alert"></span>
      </div>
      <div class="config-warning" id="help-${envKey}">${esc(CONFIG_HELP[envKey] ?? '')} Range: ${min}–${max}; default: ${defaultValue}. <span class="mono">${envKey}</span></div>`;
  }).join('');
  return `
      <section class="panel config-panel pre-pr-config-panel" aria-labelledby="pre-pr-config-title">
        <div class="panel-head"><span class="panel-title" id="pre-pr-config-title">Pre-${term('pr')} ${term('review').toLowerCase()}</span></div>
        <div class="config-warning">Adversarial ${term('reviews').toLowerCase()} run before a new coding ${term('run').toLowerCase()} publishes its ${term('pr')}. Every reviewer must approve the final commit. Changes apply to newly launched ${term('runs').toLowerCase()}; active ${term('runs').toLowerCase()} keep their settings. Supported CLIs: Codex and Claude Code. With only one installed, one reviewer runs.</div>
        <div class="config-list">${rows}</div>
      </section>`;
}

function jiraTokenRowHtml(tokenSet: boolean): string {
  const status: string = tokenSet
    ? '<span class="config-secret-status is-set">set ✓</span>'
    : '<span class="config-secret-status is-unset">not set</span>';
  return `
      <div class="config-row config-secret-row" data-key="JIRA_API_TOKEN">
        <label class="config-key mono" for="config-JIRA_API_TOKEN">JIRA_API_TOKEN ${status}<span class="config-hint" tabindex="0" role="img" aria-label="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed." title="Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed.">${ICON_INFO}</span></label>
        <input id="config-JIRA_API_TOKEN" class="config-input config-secret-input" type="password" autocomplete="off" placeholder="Paste new token to update" aria-describedby="help-JIRA_API_TOKEN error-JIRA_API_TOKEN">
        <button type="button" class="config-save" data-key="JIRA_API_TOKEN" aria-label="Update Jira API token">Update</button>
        <span class="config-error" id="error-JIRA_API_TOKEN" role="alert"></span>
        <span class="sr-only" id="help-JIRA_API_TOKEN">Write-only. Paste a new Atlassian API token; applies live, no restart. Never displayed.</span>
      </div>`;
}

function configCustomizationPanel(themeId: string): string {
  const themeOptions = THEMES.map(
    (theme) => `<option value="${esc(theme.id)}"${theme.id === themeId ? ' selected' : ''}>${esc(theme.label)}</option>`,
  ).join('');
  return `      <section class="panel config-panel ui-customization-panel" aria-labelledby="ui-customization-title">
        <div class="panel-head"><span class="panel-title" id="ui-customization-title">UI customization</span></div>
        <div class="ui-customization-body">
          <p id="pirate-mode-help">Toggle Pirate mode with the flag at the bottom-right of every page. The preference is saved in this browser; your content stays unchanged.</p>
          <details class="terminology-reference"><summary>Terminology reference</summary><table><thead><tr><th scope="col">Plain</th><th scope="col">Pirate</th></tr></thead><tbody>${TERMINOLOGY_REFERENCE_KEYS.map(key => TERMINOLOGY[key]).map(({ plain, pirate }) => `<tr><td>${esc(plain)}</td><td>${esc(pirate)}</td></tr>`).join('')}</tbody></table></details>
          <label for="ui-theme">Theme</label>
          <select id="ui-theme" class="theme-select" aria-describedby="ui-theme-help">${themeOptions}</select>
          <p id="ui-theme-help">Applies immediately and is saved in this browser.</p>
          ${renderThemePreview()}
        </div>
      </section>`;
}

export function renderConfigView(uiConfig: UiConfig, opts: ConfigViewOpts): string {
  const customization = configCustomizationPanel(opts.themeId);
  const operatorNote = `<div class="operator-note mono">${ICON_LOCK}<span>${term('operatorNote')}</span></div>`;
  const intro = `<header class="page-intro"><h1>Config</h1><p>Configure work sources, integrations, and ${term('agent').toLowerCase()} defaults. Save each setting separately.</p></header>`;
  const status = `${opts.error ? `<div class="config-load-error degraded-banner" role="alert">${esc(opts.error)}${opts.unavailable ? '' : ' Showing the last loaded settings.'} <button type="button" data-config-retry${opts.loading ? ' disabled' : ''}>Try again</button></div>` : ''}${opts.loading ? '<p class="empty-note" role="status">Loading configuration…</p>' : ''}`;
  if (opts.unavailable) {
    return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `${intro}<section class="panel config-loading" aria-label="Configuration" aria-busy="${Boolean(opts.loading)}">${status || '<p class="empty-note">Configuration is unavailable. <button type="button" data-config-retry>Try again</button></p>'}</section>${customization}${operatorNote}`);
  }
  const jiraEnabled = uiConfig.config?.JIRA_ENABLED !== 'false' && uiConfig.config?.JIRA_ENABLED !== false;
  return renderAppShell({ active: 'config', repos: opts.repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: null }, `
      ${intro}${status}
      <section class="panel config-panel" aria-labelledby="work-source-title">
        <div class="panel-head"><span class="panel-title" id="work-source-title">${term('runSource')}</span></div>
        <div class="config-list">
          <div class="config-row" data-key="JIRA_ENABLED">
            <label class="config-key" for="jira-enabled">Jira integration</label>
            <select class="config-input" id="jira-enabled" aria-describedby="jira-enabled-help error-JIRA_ENABLED">
              <option value="true"${jiraEnabled ? ' selected' : ''}>Enabled — Jira tickets</option>
              <option value="false"${jiraEnabled ? '' : ' selected'}>Disabled — local todos</option>
            </select>
            <button type="button" class="config-save" data-key="JIRA_ENABLED" aria-label="Save Jira integration">Save</button>
            <span class="config-error" id="error-JIRA_ENABLED" role="alert"></span>
          </div>
        </div>
        <p class="config-warning" id="jira-enabled-help">Disabling Jira replaces Triage and Bugs with Todos. The backlog and auto-claim use local todos. Saved credentials and todos are kept when switching sources.</p>
        ${jiraEnabled ? '' : `<p class="config-warning"><a class="app-link" href="${esc(routeHref({ view: 'todos', repo: opts.selectedRepo }))}">Manage todos →</a></p>`}
      </section>
      ${customization}
      <section class="panel config-panel slack-review-config" aria-labelledby="slack-review-config-title">
        <div class="panel-head"><span class="panel-title" id="slack-review-config-title">Slack integration</span></div>
        <p class="config-warning">The button on your open ${term('prs')} posts the ${term('pr')} link and tags your ${term('review').toLowerCase()} group. Requests are sent only when you click it.</p>
        <div class="config-list">
          ${[['SLACK_ENABLED', 'Slack integration', 'true'], ['SLACK_WATCH_ENABLED', 'Automatic reviews from Slack', 'false']].map(([key, label, fallback]) => `
            <div class="config-row" data-key="${key}">
              <label class="config-key" for="config-${key}">${label}</label>
              <select id="config-${key}" class="config-input" aria-describedby="slack-review-setup error-${key}">
                <option value="true"${String(uiConfig.config?.[key] ?? fallback) === 'true' ? ' selected' : ''}>On</option>
                <option value="false"${String(uiConfig.config?.[key] ?? fallback) === 'false' ? ' selected' : ''}>Off</option>
              </select>
              <button type="button" class="config-save" data-key="${key}" aria-label="Save ${label}">Save</button><span class="config-error" id="error-${key}" role="alert"></span>
            </div>`).join('')}
          <div class="config-row" data-key="SLACK_BROWSER">
            <label class="config-key" for="config-SLACK_BROWSER">Slack browser</label>
            <select id="config-SLACK_BROWSER" class="config-input" aria-describedby="slack-review-setup error-SLACK_BROWSER">
              <option value="firefox"${uiConfig.config?.SLACK_BROWSER === 'firefox' ? ' selected' : ''}>Firefox</option>
              <option value="cmux"${uiConfig.config?.SLACK_BROWSER !== 'firefox' ? ' selected' : ''}>cmux embedded browser</option>
            </select>
            <button type="button" class="config-save" data-key="SLACK_BROWSER" aria-label="Save Slack browser">Save</button><span class="config-error" id="error-SLACK_BROWSER" role="alert"></span>
          </div>
          ${[['SLACK_FIREFOX_WEBDRIVER_URL', 'Firefox bridge address', 'http://127.0.0.1:4444'], ['SLACK_CLIENT_ID', 'Slack client ID', ''], ['SLACK_CHANNEL_ID', 'Watched channel ID', ''], ['SLACK_CHANNEL_NAME', 'Watched channel name', ''], ['SLACK_BROWSER_SURFACE', 'Browser tab reference (optional)', ''], ['SLACK_REVIEW_CHANNEL', 'Review request channel', 'airo-editing'], ['SLACK_REVIEW_MENTION', `${term('review')} group handle`, 'airo-editing-squad']].map(([key, label, fallback]) => `
            <div class="config-row" data-key="${key}">
              <label class="config-key" for="config-${key}">${label}</label>
              <input id="config-${key}" class="config-input" value="${esc(String(uiConfig.config?.[key] ?? fallback))}" aria-describedby="slack-review-setup error-${key}">
              <button type="button" class="config-save" data-key="${key}" aria-label="Save ${label}">Save</button><span class="config-error" id="error-${key}" role="alert"></span>
            </div>`).join('')}
        </div>
        <p class="config-warning" id="slack-review-setup">Turning Slack off stops automatic reviews and blocks manual requests. Saved settings are retained. Uses your signed-in Slack browser. Set a channel name or ID and an @group handle. Existing message drafts are preserved. Firefox uses your regular signed-in browser with Marionette enabled and the local bridge running (<code>npm run slack:firefox</code>). The browser used to view Helmsman can be different.</p>
      </section>
      ${renderLocalGit(opts.localGit ?? emptyLocalGit(opts.selectedRepo))}
      <section class="panel config-panel">
        <div class="panel-head"><span class="panel-title">Runtime settings</span></div>
        <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
        <div class="config-list">
          ${jiraTokenRowHtml(uiConfig.jiraTokenSet === true)}
          ${configRowsHtml(uiConfig)}
        </div>
      </section>
      ${prePrConfigPanel(uiConfig)}
      ${operatorNote}
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
  error?: string | null;
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
  const intro = '<header class="page-intro"><h1>Terminal</h1><p>View and control an existing terminal session. Text and keys are sent directly to the selected tab.</p></header>';
  const error = state.error ? `<div class="cmux-load-error degraded-banner" role="alert">${esc(state.error)} <button type="button" data-cmux-refresh>Try again</button></div>` : '';
  if (!state.connected) {
    return renderAppShell(opts, `${intro}${error}${state.error ? '' : '<div class="panel empty-note" role="status">Terminal not connected. Open your configured terminal app, then refresh. <button type="button" data-cmux-refresh>Refresh</button></div>'}`);
  }

  const list: string = state.tabs.length
    ? state.tabs
        .map(
          (t) => `
      <button class="cmux-tab${t.surfaceRef === state.selectedSurface ? ' is-selected' : ''}" type="button" data-surface="${esc(t.surfaceRef)}" aria-pressed="${t.surfaceRef === state.selectedSurface}">
        <span class="cmux-tab-title">${esc(t.surfaceTitle)}</span>
        <span class="cmux-tab-meta mono">${esc(t.workspaceTitle)} &middot; ${esc(t.type)}</span>
      </button>`,
        )
        .join('')
    : '<div class="empty-note" role="status">No terminal tabs available. Open a terminal tab in your configured terminal app, then refresh. <button type="button" data-cmux-refresh>Refresh</button></div>';

  const selected: CmuxTabView | null = state.tabs.find((t) => t.surfaceRef === state.selectedSurface) ?? null;

  const detail: string = selected
    ? `
      <div class="cmux-capture-row">
        <button class="cmux-capture-toggle${state.isCapturing ? ' is-active' : ''}" type="button"${state.isCapturing ? ' aria-describedby="cmux-capture-help"' : ''} data-cmux-capture aria-pressed="${state.isCapturing ? 'true' : 'false'}">${state.isCapturing ? 'Stop keyboard control' : 'Control with keyboard'}</button>
        ${state.isCapturing ? `<span class="cmux-capture-hint" id="cmux-capture-help">Keys go directly to ${esc(selected.surfaceTitle)} while the screen has focus. Press Shift+Escape to stop keyboard control.</span>` : ''}
      </div>
      <pre class="cmux-screen mono${state.isCapturing ? ' is-capturing' : ''}" tabindex="0"${state.isCapturing ? ' aria-describedby="cmux-capture-help"' : ''} aria-label="Screen output from ${esc(selected.surfaceTitle)}">${esc(state.screen)}</pre>
      <div class="cmux-keypad">
        ${CMUX_NAV_KEYS.map((k) => `<button class="cmux-keypad-btn" type="button" data-key="${esc(k.key)}" aria-label="Send ${esc(k.key)} key" title="Send ${esc(k.key)} key">${k.label}</button>`).join('')}
      </div>
      <form class="cmux-send">
        <label class="interface-field">Send text to ${esc(selected.surfaceTitle)}<input class="cmux-input" name="text" placeholder="Command or message" autocomplete="off" /></label>
        <button type="submit">Send + Enter</button>
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
    ${intro}${error}
    <div class="cmux-body">
      <div class="panel cmux-list${listCollapsed ? ' is-collapsed' : ''}">
        <div class="panel-head"><span class="panel-title">Terminal tabs</span>${surfaceCollapseBtn('cmux:list', 'Terminal tabs', listCollapsed)}</div>
        <div class="cmux-list-body">${list}</div>
      </div>
      <div class="panel cmux-detail${detailCollapsed ? ' is-collapsed' : ''}">
        <div class="panel-head"><span class="panel-title">Terminal screen</span>${surfaceCollapseBtn('cmux:detail', 'Terminal screen', detailCollapsed)}</div>
        <div class="cmux-detail-body">${detail}</div>
      </div>
    </div>
`);
}
