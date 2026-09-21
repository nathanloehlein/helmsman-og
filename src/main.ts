import { applyBootTerminology } from './logic/bootTerminology';
import { term, setPirateMode, isPirateMode } from './logic/terminology';
import { loadProfile } from './data/profile';
import { copyText } from './logic/clipboard';
import { RUN_LOG_PREVIEW_LIMIT } from './logic/runLog';
import { appendHighlightedLog } from './logic/logHighlight';
import { getContext } from './data/context';
import { fetchTodos, createTodo, updateTodo, deleteTodo } from './data/todoClient';
import { renderTodosView, renderTodoList, readTodoForm, type TodosViewState } from './renderTodos';
import { TODO_STATES } from './data/todos';
import { emptyLocalGit, fetchLocalGit, updateLocalGit, type LocalGitAction, type LocalGitState } from './data/localGit';
import { renderLocalGit } from './renderLocalGit';
import { fetchSlack, markSlackNotificationRead, unavailableSlack, type SlackState } from './data/slack';
import { renderSlack } from './renderSlack';
import { fetchSlackReviewRequests, requestSlackReview, SlackReviewRequestError, type SlackReviewResult, type SlackReviewRequestState } from './data/slackReview';
import { formatRelativeTime } from './logic/time';
import './style.css';
import { parseRoute, routeHref, type AppRoute, type PageView } from './logic/routes';
import { renderRunsView, renderRunHistory, type RunHistoryState } from './renderRuns';
import { fetchRunHistory, RUN_HISTORY_PAGE_SIZE } from './data/runHistory';
import { fetchOutcomes, saveOutcomeAssessment, OUTCOME_WINDOWS, type OutcomeWindow } from './data/outcomeClient';
import { renderOutcomesView, type OutcomesViewState } from './renderOutcomes';
import { mountCampaigns } from './renderCampaigns';
import { mountClarifications } from './renderClarifications';
import type { OutcomeSummary } from './data/outcomes';
import './outcomes.css';
import { loadDashboard, POLL_MS, LOCAL_POLL_MS, type DashboardResponse } from './data/live';
import { renderAppShell, renderHelmHead, type HelmHeadOpts, renderDashboard, renderPrPanel, renderCmuxView, renderRunsDrawer, renderVoyageRetry, runTabStatus, renderTriageView, renderBugsView, renderConfigView, renderPrView, renderPrLists, renderRepoPrs, renderRecentPrRuns } from './render';
import type { RunTabView, PrViewState } from './render';
import type { DashboardSnapshot } from './data/mock';
import { assignTicketToMe, fetchTriage, type TriageGroupsView } from './data/triage';
import { filterTriageTickets, TRIAGE_PRIORITIES, TRIAGE_DATE_OPTIONS, type TriageFilters } from './logic/triageFilters';
import { paginateTriageTickets, TRIAGE_PAGE_SIZES, type TriagePageSize, type TriagePages } from './logic/triagePagination';
import { fetchBugs } from './data/bugs';
import type { BugsResponse } from './types';
import { fetchReviewRequests, fetchRepoOpenPrs, type PrListState, type PrInboxState } from './data/prLists';
import {
  launchAgent,
  launchRun,
  retryRun,
  openRunStream,
  getRun,
  fetchAgents,
  stopAgent,
  setAutoClaim,
  type AgentCaps,
  type LaunchResult,
  type LaunchRunBody,
  type RunEvent,
  type RunStreamState,
  type RunStatusSummary,
  type RunSummary,
} from './data/agents';
import { getConfig, setConfig, type UiConfig } from './data/config';
import { getPrStatus, getPrDiff, submitReview as submitPrReview, parsePrUrl, type PrStatusView } from './data/pr';
import { selectSurface, isPolling, providerOf, parseCmuxTabs, type CmuxTabView, type PanelState } from './logic/cmuxPanel';
import { mapKeyEvent, type CmuxKeyIntent } from './logic/cmuxKeys';
import { applyTheme, loadThemeId, saveThemeId } from './data/themes';
import {
  loadRepoScope,
  saveRepoScope,
  loadRackLayoutRaw,
  saveRackLayoutRaw,
  loadCollapsed,
  saveCollapsed,
  loadTriageFilters,
  saveTriageFilters,
  loadTriagePageSize,
  saveTriagePageSize,
} from './logic/prefs';
import {
  deserialize as deserializeRack,
  movePanel,
  serialize as serializeRack,
  setActive as setActivePanel,
  stackOnto,
  toggleCollapse,
  type PanelId,
  type RackLayout,
} from './logic/rack';

const RUN_LOG_BATCH_MS = 32;

const CMUX_SCREEN_POLL_MS: number = 2_000;
const CMUX_SCREEN_UNAVAILABLE: string = 'Screen unavailable — tab has no rendered output yet.';

interface CmuxScreenPayload {
  surface?: string;
  text?: string;
}

interface CmuxEventPayload {
  kind?: string;
}

interface RunTab {
  runId: string;
  label: string;
  lines: RunEvent[];
  streamState?: RunStreamState;
  lastEventId?: number;
  footer: RunStatusSummary | null;
  pr: { repo: string; number: number } | null;
  unsub: (() => void) | null;
  complete: boolean;
  status?: string;
  prStatus?: PrStatusView | null;
  prLoadedAt?: number;
  prVersion?: number;
  prPending?: Promise<void>;
}

interface SlackReviewUiState {
  requestId: string;
  requestedAt: string;
  pending: boolean;
  error?: string;
  result?: SlackReviewResult;
}

function canRequestSlackAgain(state: SlackReviewUiState | undefined, saved: SlackReviewRequestState | undefined): boolean {
  const savedAt = saved?.status === 'sent' ? saved.lastSentAt ?? saved.lastRequestedAt : null;
  const sentAt = state ? state.result ? state.result.sentAt ?? (saved?.requestId === state.requestId ? savedAt : null) : null : savedAt;
  return Boolean(sentAt && Number.isFinite(Date.parse(sentAt)) && Date.now() - Date.parse(sentAt) >= 60_000);
}

function deriveTicketStatus(summary: RunStatusSummary): string {
  if (summary.status === 'succeeded' && summary.prNumber != null) return term('inReview');
  if (summary.status === 'succeeded') return term('success');
  if (summary.status === 'failed') return term('failed');
  if (summary.status === 'stopped') return 'Stopped';
  return summary.status;
}

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly rootEvents = new window.AbortController();
  private readonly runDrawerEl: HTMLElement;
  private runTabs: RunTab[] = [];
  private activeTabId: string | null = null;
  private tabSeq: number = 0;
  private stickToBottom: boolean = true;
  private runLogTimer: ReturnType<typeof setTimeout> | null = null;
  private renderedRunLines: RunEvent[] = [];
  private destroyed = false;
  private copyTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  private copying = new WeakSet<HTMLButtonElement>();
  private runRetries = new Map<string, { pending: boolean; error?: string }>();
  private snapshot: DashboardSnapshot | null = null;
  private snapshotRepo: string | null | undefined = undefined;
  private contentView: PageView | null = null;
  private newRunRepoScope: string | null | undefined = undefined;
  private degraded: string[] = [];
  private repos: string[] = [];
  private hasContext: boolean = false;
  private selectedRepo: string | null = loadRepoScope();
  private runs: RunSummary[] = [];
  private historyRuns: RunSummary[] = [];
  private runHistory: RunHistoryState = { total: 0, offset: 0, limit: RUN_HISTORY_PAGE_SIZE, loading: true, error: null };
  private runHistorySeq = 0;
  private runHistoryPending: { repo: string | null; offset: number; promise: Promise<void> } | null = null;
  private autoClaimRepos: string[] = [];
  private caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null };
  private uiConfig: UiConfig = { config: {}, overridden: [] };
  private configLoaded = false;
  private configLoading = false;
  private configError: string | null = null;
  private configSeq = 0;
  private configDrafts = new Map<string, string>();
  private configErrors = new Map<string, string>();
  private configPendingKeys = new Set<string>();
  private rackLayout: RackLayout = deserializeRack(loadRackLayoutRaw());
  private collapsed: Set<string> = loadCollapsed();
  private launchSeq: number = 0;
  private newRunPending = false;
  private refreshSeq: number = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPending: { repo: string | null; view: PageView; promise: Promise<void> } | null = null;
  private lastLocalRefresh: number = -Infinity;
  private lastDashboardRefresh: number = -Infinity;
  private dashboardRepo: string | null | undefined = undefined;
  private lastReviewRequestsRefresh: number = -Infinity;
  private reviewRequestsRepo: string | null | undefined = undefined;
  private lastRepoPrsRefresh: number = -Infinity;
  private repoPrsRepo: string | null | undefined = undefined;
  private readonly onVisibilityChange = (): void => {
    this.syncCmuxPolling();
    if (document.hidden) this.cancelRunLogFlush();
    else this.scheduleRunLogFlush();
    if (!document.hidden) {
      void this.refresh(false);
      if (this.view === 'cmux') void this.handleCmuxTabsChanged();
    }
  };
  private repoPrsSeq: number = 0;
  private reviewRequestsSeq: number = 0;
  private reviewRequestsPending: { repo: string | null; seq: number; promise: Promise<void> } | null = null;
  private repoPrsPending: { repo: string | null; seq: number; promise: Promise<void> } | null = null;
  private prViewSeq: number = 0;
  private dashboardUnavailable: boolean = false;
  private repoPrs: PrListState = { prs: [], loading: false, degraded: false, truncated: false };
  private reviewRequests: PrListState = { prs: [], loading: true, degraded: false, truncated: false };
  private view: PageView = 'dashboard';
  private route: AppRoute = parseRoute(new URL('/helm', window.location.origin));
  private routeSeq: number = 0;
  private triageSeq: number = 0;
  private bugsSeq: number = 0;
  private localGit: LocalGitState = emptyLocalGit(null);
  private localGitSeq: number = 0;
  private localGitPending: { repo: string; promise: Promise<void> } | null = null;
  private localGitOperations = new Map<string, Promise<void>>();
  private readonly onResize = (): void => { this.revealActiveTab(); };
  private readonly onPopState = (): void => { void this.navigate(parseRoute(new URL(window.location.href)), 'none'); };
  private prView: PrViewState = { repo: null, number: null, pr: null, diff: null, loading: false };
  private triageGroups: TriageGroupsView = { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] };
  private triageDegraded: boolean = false;
  private triageFilters: TriageFilters = loadTriageFilters();
  private triagePageSize: TriagePageSize = loadTriagePageSize();
  private triagePages: TriagePages = { backlog: 1, todo: 1, mine: 1 };
  private bugsResponse: BugsResponse | null = null;
  private cmuxConnected: boolean = false;
  private cmuxTabsError: string | null = null;
  private cmuxTabsSeq = 0;
  private cmuxTabs: CmuxTabView[] = [];
  private cmuxPanelState: PanelState = { selectedSurface: null };
  private cmuxScreen: string = '';
  private cmuxScreenTimer: ReturnType<typeof setInterval> | null = null;
  private cmuxScreenPending: boolean = false;
  private cmuxEventSource: EventSource | null = null;
  private cmuxCapturing: boolean = false;
  private readonly onCaptureKeydown = (event: KeyboardEvent): void => this.handleCaptureKeydown(event);
  private themeId: string = loadThemeId();
  private greetingName: string | null = null;
  private configSaves: number = 0;
  private pendingViewActions: number = 0;
  private jiraBaseUrl: string | null = null;
  private jiraEnabled: boolean = true;
  private todos: TodosViewState = { items: [], loading: false, error: null, search: '', stateFilter: 'all' };
  private todosSeq: number = 0;
  private slack: SlackState = unavailableSlack();
  private slackOpen: boolean = false;
  private slackError: string | null = null;
  private slackSeq: number = 0;
  private slackReads = new Set<string>();
  private slackReviewRequests = new Map<string, SlackReviewUiState>();
  private slackReviewHistory = new Map<string, SlackReviewRequestState>();
  private slackReviewHistoryUnavailable = false;
  private outcomes: OutcomeSummary | null = null;
  private outcomeDays: OutcomeWindow = 30;
  private outcomesLoading = false;
  private outcomesError: string | null = null;
  private outcomesSeq = 0;
  private outcomesSavingRunId: string | null = null;
  private outcomesEditing = false;
  private campaigns: ReturnType<typeof mountCampaigns> | null = null;
  private clarifications: ReturnType<typeof mountClarifications> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    applyTheme(this.themeId);
    this.root.addEventListener('click', (event: MouseEvent): void => this.handleClick(event), { signal: this.rootEvents.signal });
    this.root.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.slackOpen) {
        this.slackOpen = false;
        this.paintSlack();
        this.root.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus();
        return;
      }
      const tab = event.target;
      if (tab instanceof HTMLButtonElement && tab.matches('.rack-handle')) {
        this.handleRackKeyboardMove(tab, event);
        return;
      }
      if (tab instanceof HTMLButtonElement && tab.matches('.slot-tab')) {
        const tabs = Array.from(tab.closest('.slot-tabs')?.querySelectorAll<HTMLButtonElement>('.slot-tab') ?? []);
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) {
          event.preventDefault();
          tabs[next]?.click();
        }
        return;
      }
      if (tab instanceof HTMLAnchorElement && tab.matches('.page-tab')) {
        const tabs = Array.from(this.root.querySelectorAll<HTMLAnchorElement>('.page-tab'));
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) {
          event.preventDefault();
          tabs.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1; });
          tabs[next]?.focus();
        } else if (event.key === ' ') {
          event.preventDefault();
          tab.click();
        }
        return;
      }
      if (tab instanceof HTMLButtonElement && tab.matches('.run-tab-select')) {
        const tabs = Array.from(this.runDrawerEl.querySelectorAll<HTMLButtonElement>('.run-tab-select'));
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        const runId = next === null ? undefined : tabs[next]?.dataset.tabid;
        if (runId) {
          event.preventDefault();
          this.setActiveTab(runId);
          this.focusRunTab(runId);
        }
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('.underway-row[data-underway-href]')) {
        event.preventDefault();
        this.openUnderwayRow(target);
        return;
      }
      if (!(target instanceof HTMLElement) || !target.matches('.pr-list-row')) return;
      event.preventDefault();
      this.handlePrListClick(target);
    }, { signal: this.rootEvents.signal });
    this.root.addEventListener('change', (event: Event): void => {
      const control = event.target;
      if (control instanceof HTMLInputElement && control.matches('.local-git-cleanup-force')) {
        if (control.disabled || this.localGit.loading || this.localGit.pendingAction) return;
        this.localGit = { ...this.localGit, cleanup: undefined, cleanupForce: control.checked };
        this.paintLocalGit();
        this.root.querySelector<HTMLInputElement>('.local-git-cleanup-force')?.focus();
        return;
      }
      if (this.view === 'todos' && control instanceof HTMLSelectElement && control.matches('[data-todo-state-filter]')) {
        this.todos.stateFilter = TODO_STATES.find(state => state === control.value) ?? 'all';
        this.paintTodoList();
        return;
      }
      if (this.view === 'triage' && control instanceof HTMLInputElement && control.matches('[data-triage-priority]')) {
        const priority = TRIAGE_PRIORITIES.find(priority => priority === control.dataset.triagePriority);
        if (!priority) return;
        this.triageFilters.priorities = TRIAGE_PRIORITIES.filter(value => value === priority ? control.checked : this.triageFilters.priorities.includes(value));
        saveTriageFilters(this.triageFilters);
        this.triagePages = { backlog: 1, todo: 1, mine: 1 };
        this.paintTriage();
        this.root.querySelector<HTMLInputElement>(`[data-triage-priority="${priority}"]`)?.focus({ preventScroll: true });
        return;
      }
      if (!(control instanceof HTMLSelectElement)) return;
      if (this.view === 'outcomes' && control.matches('[data-outcome-days]')) {
        const days = OUTCOME_WINDOWS.find(days => String(days) === control.value);
        if (days === undefined) return;
        this.outcomeDays = days;
        void this.loadOutcomes();
      } else if (this.view === 'triage' && control.matches('[data-triage-days]')) {
        const days = TRIAGE_DATE_OPTIONS.find(days => String(days) === control.value);
        if (days === undefined) return;
        this.triageFilters.days = days;
        saveTriageFilters(this.triageFilters);
        this.triagePages = { backlog: 1, todo: 1, mine: 1 };
        this.paintTriage();
        this.root.querySelector<HTMLSelectElement>('[data-triage-days]')?.focus({ preventScroll: true });
      } else if (this.view === 'triage' && control.matches('[data-triage-page-size]')) {
        const size = TRIAGE_PAGE_SIZES.find(size => String(size) === control.value);
        if (size === undefined) return;
        this.triagePageSize = size;
        saveTriagePageSize(size);
        this.triagePages = { backlog: 1, todo: 1, mine: 1 };
        this.paintTriage();
        this.root.querySelector<HTMLSelectElement>('[data-triage-page-size]')?.focus({ preventScroll: true });
      } else if (control.matches('.repo-select')) {
        void this.navigate({ ...this.route, view: this.view, repo: control.value || null, prRepo: null, pr: null, run: null });
      } else if (control.matches('.theme-select')) {
        this.themeId = control.value;
        applyTheme(this.themeId);
        saveThemeId(this.themeId);
      }
    }, { capture: true, signal: this.rootEvents.signal });
    this.root.addEventListener('submit', (event: SubmitEvent): void => this.handleSubmit(event), { signal: this.rootEvents.signal });
    this.root.addEventListener('input', (event: Event): void => {
      const control = event.target;
      if (!(control instanceof HTMLElement)) return;
      if (this.view === 'outcomes' && control.closest('[data-outcome-assessment]')) {
        this.outcomesEditing = true;
        return;
      }
      if (this.view !== 'todos') return;
      if (control instanceof HTMLInputElement && control.matches('[data-todo-search]')) {
        this.todos.search = control.value;
        this.paintTodoList();
      }
      const form = control.closest<HTMLFormElement>('[data-todo-form]');
      if (form) {
        const draft = readTodoForm(form);
        if (!this.todos.editingId && this.todos.draft?.repo === undefined && !control.matches('[name="repo"]')) {
          this.todos.draft = { ...draft, repo: undefined };
        } else this.todos.draft = draft;
      }
    }, { signal: this.rootEvents.signal });
    this.root.addEventListener('paste', (event: ClipboardEvent): void => void this.handlePasteImage(event), { signal: this.rootEvents.signal });

    const drawer: HTMLDivElement = document.createElement('div');
    drawer.className = 'run-drawer';
    this.runDrawerEl = drawer;
    this.renderRunDrawer();
  }

  async start(): Promise<void> {
    void this.loadGreeting();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const route = parseRoute(new URL(window.location.href));
    this.selectedRepo = route.repo;
    this.view = route.view;
    if (route.view !== 'dashboard' && route.view !== 'prs') {
      const context = await getContext();
      if (context) {
        this.repos = context.repos;
        this.jiraBaseUrl = context.jiraBaseUrl;
        this.jiraEnabled = context.jiraEnabled !== false;
        this.hasContext = true;
      }
    }
    await this.refresh();
    await this.navigate(route, 'replace');
    this.refreshTimer = setInterval(() => void this.refresh(false), LOCAL_POLL_MS);
  }

  private async loadGreeting(): Promise<void> {
    const profile = await loadProfile();
    if (this.destroyed) return;
    this.greetingName = profile.displayName ?? profile.login;
    this.syncShell();
  }

  private syncPirateToggle(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-pirate-mode]');
    if (toggle) {
      toggle.disabled = this.configSaves > 0 || this.pendingViewActions > 0;
      toggle.setAttribute('aria-pressed', String(isPirateMode()));
      toggle.title = `Turn Pirate mode ${isPirateMode() ? 'off' : 'on'}`;
    }
  }

  private async withStableView(action: () => Promise<void>): Promise<void> {
    ++this.pendingViewActions;
    this.syncPirateToggle();
    try {
      await action();
    } finally {
      --this.pendingViewActions;
      this.syncPirateToggle();
    }
  }

  private changePirateMode(enabled: boolean): void {
    if (this.configSaves > 0 || this.pendingViewActions > 0) return;
    const controls = (): Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> => {
      const result = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
      const occurrences = new Map<string, number>();
      for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
        const scope = control.closest('.run-drawer') ? 'drawer' : 'page';
        const identity = `${scope}:${control.tagName}:${control.id || control.name || control.className}`;
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        result.set(`${identity}:${occurrence}`, control);
      }
      return result;
    };
    const savedControls = controls();
    const openDetails = Array.from(this.root.querySelectorAll('details'), detail => detail.open);
    const pageScroll = this.root.querySelector('#page-content')?.scrollTop ?? 0;
    const logScroll = this.runDrawerEl.querySelector('.run-drawer-body')?.scrollTop ?? 0;
    const followLog = this.stickToBottom;
    setPirateMode(enabled);
    this.paint();
    this.paintSlack();
    this.renderRunDrawer(false);
    this.stickToBottom = followLog;
    this.flushRunLog();
    const log = this.runDrawerEl.querySelector('.run-drawer-body');
    if (log && !followLog) log.scrollTop = logScroll;
    this.updateAddress(this.route, 'replace');
    const template = document.createElement('template');
    template.innerHTML = renderAppShell(this.shellOptions(), '');
    const footer = template.content.querySelector('.app-footer');
    if (footer) this.root.querySelector('.app-footer')?.replaceWith(footer);
    for (const [key, control] of controls()) {
      const previous = savedControls.get(key);
      if (!previous) continue;
      control.value = previous.value;
      if (control instanceof HTMLInputElement && previous instanceof HTMLInputElement) control.checked = previous.checked;
    }
    this.root.querySelectorAll('details').forEach((detail, index) => { detail.open = openDetails[index] ?? false; });
    const page = this.root.querySelector('#page-content');
    if (page) page.scrollTop = pageScroll;
    this.root.querySelector<HTMLButtonElement>('[data-pirate-mode]')?.focus({ preventScroll: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.copyTimers.forEach(timer => clearTimeout(timer));
    this.copyTimers.clear();
    this.cancelRunLogFlush();
    this.rootEvents.abort();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    ++this.routeSeq;
    ++this.runHistorySeq;
    ++this.refreshSeq;
    ++this.prViewSeq;
    ++this.reviewRequestsSeq;
    ++this.repoPrsSeq;
    ++this.localGitSeq;
    ++this.slackSeq;
    ++this.todosSeq;
    window.removeEventListener('popstate', this.onPopState);
    this.stopCmuxScreenPoll();
    this.stopCapture();
    this.campaigns?.destroy();
    this.campaigns = null;
    this.clarifications?.destroy();
    this.clarifications = null;
    this.cmuxEventSource?.close();
    this.runTabs.forEach(tab => tab.unsub?.());
  }

  private updateAddress(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): void {
    const href = routeHref(route);
    this.route = parseRoute(new URL(href, window.location.origin));
    if (history === 'replace') window.history.replaceState(null, '', href);
    else if (history === 'push' && href !== window.location.pathname + window.location.search) window.history.pushState(null, '', href);
    document.title = `${route.view === 'dashboard' ? term('dashboard') : route.view === 'prs' ? term('prs') : route.view === 'runs' ? term('runs') : route.view === 'outcomes' ? term('costsOutcomes') : route.view === 'campaigns' ? term('campaigns') : route.view === 'clarifications' ? term('clarifications') : route.view === 'cmux' ? 'Terminal' : route.view[0]!.toUpperCase() + route.view.slice(1)} · Helmsman`;
  }

  private async navigate(route: AppRoute, history: 'push' | 'replace' | 'none' = 'push'): Promise<void> {
    if (this.view === 'campaigns' && route.view !== 'campaigns') {
      this.campaigns?.destroy();
      this.campaigns = null;
    }
    if (this.view === 'clarifications' && route.view !== 'clarifications') {
      this.clarifications?.destroy();
      this.clarifications = null;
    }
    if (!this.jiraEnabled && (route.view === 'triage' || route.view === 'bugs')) {
      route = { ...route, view: 'todos', pane: null };
    } else if (this.jiraEnabled && route.view === 'todos') {
      route = { ...route, view: 'config', pane: null };
    }
    const seq = ++this.routeSeq;
    if (this.view === 'runs' && route.view !== 'runs') {
      ++this.runHistorySeq;
      this.runHistoryPending = null;
      this.runHistory.loading = false;
    }
    ++this.prViewSeq;
    this.stopCmuxScreenPoll();
    this.stopCapture();
    this.cmuxCapturing = false;
    const scope = route.repo;
    const scopeChanged = this.selectedRepo !== scope;
    if (scopeChanged) {
      ++this.runHistorySeq;
      this.runHistoryPending = null;
      this.historyRuns = [];
      this.runHistory = { total: 0, offset: 0, limit: RUN_HISTORY_PAGE_SIZE, loading: true, error: null };
      this.snapshot = null;
      this.snapshotRepo = undefined;
      this.dashboardRepo = undefined;
      this.lastDashboardRefresh = -Infinity;
      this.dashboardUnavailable = false;
      this.triagePages = { backlog: 1, todo: 1, mine: 1 };
      this.triageGroups = { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] };
      this.triageDegraded = false;
      ++this.triageSeq;
      this.bugsResponse = null;
      ++this.bugsSeq;
      ++this.refreshSeq;
      this.refreshPending = null;
      ++this.reviewRequestsSeq;
      this.reviewRequestsPending = null;
      this.reviewRequestsRepo = undefined;
      this.lastReviewRequestsRefresh = -Infinity;
      this.reviewRequests = { prs: [], loading: true, degraded: false, truncated: false };
      this.repoPrs = { prs: [], loading: false, degraded: false, truncated: false };
      this.repoPrsRepo = undefined;
      ++this.repoPrsSeq;
      ++this.localGitSeq;
      this.localGitPending = null;
      this.localGit = emptyLocalGit(scope);
      ++this.outcomesSeq;
      this.outcomes = null;
      this.outcomesError = null;
    }
    this.selectedRepo = scope;
    saveRepoScope(scope);
    this.view = route.view;
    if (route.view === 'cmux') {
      this.cmuxPanelState = { selectedSurface: null };
      this.cmuxScreen = '';
    }
    this.updateAddress(route, history);
    if (route.pane && this.view === 'dashboard') {
      this.rackLayout = setActivePanel(this.rackLayout, route.pane as PanelId);
      this.rackLayout = this.rackLayout.map(col => col.map(slot => slot.active === route.pane ? { ...slot, collapsed: false } : slot));
    }
    if (route.pane) this.collapsed.delete(`${route.view}:${route.pane === 'tabs' ? 'list' : route.pane === 'screen' ? 'detail' : route.pane}`);
    if (route.run || route.pane === 'tasks') this.collapsed.delete('runs:drawer');
    if (route.view === 'prs' || route.view === 'runs') {
      this.prView = { repo: route.pr ? route.prRepo ?? route.repo : null, number: route.pr, pr: null, diff: null, loading: Boolean(route.pr) };
    }
    if (!route.run) this.activeTabId = null;
    this.paint();
    if (scopeChanged) this.paintSlack();
    if (scopeChanged || route.view === 'dashboard' || route.view === 'prs') await this.refresh(false);
    if (seq !== this.routeSeq) return;
    let historyLoad: Promise<void> | undefined;
    if (route.view === 'triage') await this.loadTriage();
    else if (route.view === 'todos') await this.loadTodos();
    else if (route.view === 'bugs') await this.loadBugs();
    else if (route.view === 'outcomes') await this.loadOutcomes();
    else if (route.view === 'runs') historyLoad = this.loadRunHistory();
    else if (route.view === 'config') {
      await this.loadUiConfig();
      if (seq !== this.routeSeq) return;
      void this.loadLocalGit();
    }
    else if (route.view === 'cmux') {
      await this.loadCmuxTabs();
      if (seq !== this.routeSeq) return;
      this.cmuxPanelState = { selectedSurface: this.cmuxTabs.some(tab => tab?.surfaceRef === route.surface) ? route.surface : null };
      this.ensureCmuxEvents();
      await this.pollCmuxScreen();
      this.syncCmuxPolling();
    } else if (route.view === 'prs') await this.loadReviewRequests(false);
    else if (route.view === 'dashboard') await this.loadRepoPrs(false);
    if (seq !== this.routeSeq) return;
    const prRepo = route.prRepo ?? route.repo;
    if ((route.view === 'prs' || route.view === 'runs') && prRepo && route.pr) await this.loadPrView(prRepo, route.pr, false);
    if (seq !== this.routeSeq) return;
    if (route.view !== 'dashboard' && route.view !== 'prs' && route.view !== 'runs' && route.view !== 'config') this.paint();
    if (route.run) {
      const summary = this.runs.find(run => run?.id === route.run) ?? await getRun(route.run);
      if (seq !== this.routeSeq) return;
      if (summary) {
        this.openRunTab(route.run, summary.ticketId || (summary.prNumber ? `${term('pr')} #${summary.prNumber}` : route.run), false);
        const tab = this.runTabs.find(item => item.runId === route.run);
        if (tab) {
          tab.footer = summary;
          tab.status = summary.status;
          tab.complete = this.isTerminalRunStatus(summary.status);
          if (summary.prNumber) tab.pr = { repo: summary.repo, number: summary.prNumber };
        }
      } else this.openErrorTab(term('unavailableRunTitle'), term('unavailableRunMessage'));
    }
    this.renderRunDrawer();
    this.rehomeRunDrawer();
    this.focusRoute();
    await historyLoad;
  }

  private focusRoute(): void {
    const pane = this.route.pane;
    const target = pane ? this.root.querySelector<HTMLElement>(`[data-pane="${pane}"]`) : null;
    target?.scrollIntoView?.({ block: 'start' });
    if (this.route.mode) this.root.querySelector<HTMLElement>(this.route.mode === 'review' ? '.pr-review-agent' : '.pr-rerun-feedback')?.focus({ preventScroll: true });
    const ticket = this.root.querySelector<HTMLInputElement>('.newrun-ticket');
    if (ticket && this.route.ticket) ticket.value = this.route.ticket;
    const repo = this.root.querySelector<HTMLSelectElement>('.newrun-repo');
    if (repo && this.route.repo) repo.value = this.route.repo;
  }

  private bindPaneLinks(): void {
    const selectors: Record<string, string> = this.view === 'dashboard'
      ? Object.fromEntries(['newrun', 'backlog', 'underway', 'running', 'recent', 'repoprs', 'shipped', 'activity'].map(id => [id, `.faceplate[data-panel="${id}"]`]))
      : this.view === 'prs' ? { 'review-requests': '.pr-review-requests', authored: '.pr-authored', lookup: '.pr-lookup-panel', diff: '.pr-diff-panel' }
      : this.view === 'triage' ? { backlog: '[data-collapse-id="triage:backlog"]', todo: '[data-collapse-id="triage:todo"]', mine: '[data-collapse-id="triage:mine"]' }
      : this.view === 'cmux' ? { tabs: '[data-collapse-id="cmux:list"]', screen: '[data-collapse-id="cmux:detail"]' } : {};
    for (const [pane, selector] of Object.entries(selectors)) {
      const found = this.root.querySelector<HTMLElement>(selector);
      const panel = found?.closest<HTMLElement>('.panel, .faceplate');
      if (!panel) continue;
      panel.dataset.pane = pane;
      const head = panel.querySelector('.panel-head, .faceplate-head');
      if (!head || head.querySelector('.pane-link')) continue;
      const link = document.createElement('a');
      link.className = 'pane-link app-link';
      link.href = routeHref({ ...this.route, view: this.view, pane, repo: this.selectedRepo });
      link.textContent = '↗';
      link.setAttribute('aria-label', `Link to ${panel.querySelector('.panel-title, .faceplate-title')?.textContent ?? pane}`);
      head.append(link);
    }
  }

  refresh(force: boolean = true): Promise<void> {
    if (!force && document.hidden) return Promise.resolve();
    if (this.refreshPending?.repo === this.selectedRepo) {
      const pending = this.refreshPending;
      if ((this.view === 'dashboard' || this.view === 'prs') && pending.view !== 'dashboard' && pending.view !== 'prs') {
        return pending.promise.then(() => this.refresh(force));
      }
      return pending.promise;
    }
    const repo = this.selectedRepo;
    const promise = this.performRefresh(force).finally(() => {
      if (this.refreshPending?.promise === promise) this.refreshPending = null;
    });
    this.refreshPending = { repo, view: this.view, promise };
    return promise;
  }

  private async performRefresh(force: boolean): Promise<void> {
    const now = Date.now();
    const localDue = force || now - this.lastLocalRefresh >= LOCAL_POLL_MS;
    const dashboardDue = (!this.hasContext && this.dashboardRepo === undefined) || ((this.view === 'dashboard' || this.view === 'prs')
      && (force || this.dashboardRepo !== this.selectedRepo || now - this.lastDashboardRefresh >= (this.jiraEnabled ? POLL_MS : LOCAL_POLL_MS)));
    if (localDue) this.lastLocalRefresh = now;
    if (dashboardDue) {
      this.lastDashboardRefresh = now;
      this.dashboardRepo = this.selectedRepo;
    }
    const seq: number = ++this.refreshSeq;
    const slackSeq = ++this.slackSeq;
    const repo: string | null = this.selectedRepo;
    const [response, agents, , slack, context, slackReviews] = await Promise.all([
      dashboardDue ? loadDashboard(repo).catch((): DashboardResponse | null => null) : null,
      localDue ? fetchAgents() : null,
      force ? this.loadUiConfig(false) : null,
      localDue ? fetchSlack() : undefined,
      localDue ? getContext() : null,
      localDue && (this.view === 'dashboard' || this.view === 'prs' || this.view === 'runs' || this.route.run)
        ? fetchSlackReviewRequests() : undefined,
    ]);
    if (seq !== this.refreshSeq || repo !== this.selectedRepo) return;
    if (slackReviews !== undefined) {
      this.slackReviewHistoryUnavailable = slackReviews === null;
      if (slackReviews) {
        for (const saved of slackReviews) {
          const key = `${saved.repo.toLowerCase()}#${saved.prNumber}`;
          const local = this.slackReviewRequests.get(key);
          const previous = this.slackReviewHistory.get(key);
          if (local?.pending || previous && Date.parse(previous.lastRequestedAt) > Date.parse(saved.lastRequestedAt)) continue;
          if (saved.status !== 'sent' && (previous?.requestId === saved.requestId && previous.status === 'sent'
            || local?.requestId === saved.requestId && local.result)) continue;
          this.slackReviewHistory.set(key, saved);
          if (local && (saved.requestId === local.requestId && saved.status === 'sent'
            || Date.parse(saved.lastRequestedAt) > Date.parse(local.requestedAt))) this.slackReviewRequests.delete(key);
        }
      }
    }
    const priorJiraEnabled = this.jiraEnabled;
    if (dashboardDue) this.dashboardUnavailable = !response;
    if (response) {
      this.snapshot = response.snapshot;
      this.snapshotRepo = response.selectedRepo;
      this.degraded = response.degraded;
      this.repos = response.repos;
      this.hasContext = true;
      this.selectedRepo = response.selectedRepo;
      this.jiraBaseUrl = response.jiraBaseUrl;
      if (typeof response.jiraEnabled === 'boolean') this.jiraEnabled = response.jiraEnabled;
    }
    if (agents) {
      this.runs = agents.runs;
      this.autoClaimRepos = agents.autoClaim;
      this.caps = agents.caps;
    }
    if (force && this.configLoaded && !this.configError && this.uiConfig.config.JIRA_ENABLED !== undefined) {
      this.jiraEnabled = this.uiConfig.config.JIRA_ENABLED !== false && this.uiConfig.config.JIRA_ENABLED !== 'false';
    }
    if (context) {
      this.repos = [...new Set([...(response?.repos ?? this.repos), ...context.repos])].sort();
      this.jiraBaseUrl = context.jiraBaseUrl;
      if (typeof context.jiraEnabled === 'boolean') this.jiraEnabled = context.jiraEnabled;
    }
    if (priorJiraEnabled !== this.jiraEnabled) {
      this.uiConfig.config.JIRA_ENABLED = String(this.jiraEnabled);
      if (response?.jiraEnabled !== this.jiraEnabled) {
        this.snapshot = null;
        this.dashboardRepo = undefined;
        this.lastDashboardRefresh = -Infinity;
      }
      const sourceSelect = this.root.querySelector<HTMLSelectElement>('#jira-enabled');
      if (sourceSelect && sourceSelect !== document.activeElement && !this.configDrafts.has('JIRA_ENABLED')
        && sourceSelect.value === sourceSelect.dataset.configValue) {
        sourceSelect.value = String(this.jiraEnabled);
        sourceSelect.dataset.configValue = sourceSelect.value;
      }
    }
    this.syncShell();
    if ((!this.jiraEnabled && (this.view === 'triage' || this.view === 'bugs')) || (this.jiraEnabled && this.view === 'todos')) {
      await this.navigate({ ...this.route, view: this.jiraEnabled ? 'config' : 'todos', pane: null }, 'replace');
      return;
    }
    if (localDue && slackSeq === this.slackSeq) {
      this.slack = slack ?? {
        ...this.slack,
        health: { ...this.slack.health, status: 'unavailable', error: 'Notifications unavailable. Showing saved notifications.' },
        ...(this.slack.githubHealth ? { githubHealth: { ...this.slack.githubHealth, status: 'unavailable' as const, error: 'Notifications unavailable.' } } : {}),
      };
      this.paintSlack();
    }
    if (this.view === 'dashboard') {
      if (dashboardDue || force) this.paint();
      else if (localDue) this.paintLocalRuns();
      await this.loadRepoPrs(force);
    } else if (this.view === 'prs') {
      this.paintPrInbox();
      if (localDue) {
        const recent = this.root.querySelector('.pr-recent-runs');
        if (recent) {
          const template = document.createElement('template');
          template.innerHTML = renderRecentPrRuns(this.runs, this.selectedRepo);
          const next = template.content.firstElementChild;
          if (next) recent.replaceWith(next);
        }
      }
      await this.loadReviewRequests(force);
    } else if (this.view === 'config' && force) {
      this.paintConfig();
      void this.loadLocalGit();
    } else if (this.view === 'todos' && localDue) {
      await this.loadTodos();
    } else if (this.view === 'runs' && localDue && this.contentView === 'runs') {
      await this.loadRunHistory();
    } else if (this.view === 'outcomes' && localDue && !this.outcomesEditing && !this.outcomesSavingRunId) {
      void this.loadOutcomes();
    }
    this.paintRunRetries();
    this.paintSlackReviewRequests();
  }

  private loadRunHistory(offset = this.runHistory.offset): Promise<void> {
    const repo = this.selectedRepo;
    if (this.runHistoryPending?.repo === repo && this.runHistoryPending.offset === offset) return this.runHistoryPending.promise;
    const seq = ++this.runHistorySeq;
    if (offset !== this.runHistory.offset) this.historyRuns = [];
    this.runHistory = { ...this.runHistory, offset, loading: true, error: null };
    this.paintRunHistory();
    const current = () => !this.destroyed && this.view === 'runs' && seq === this.runHistorySeq && repo === this.selectedRepo;
    const promise = (async () => {
      try {
        let page = await fetchRunHistory(repo, offset);
        if (!current()) return;
        if (page.offset > 0 && page.offset >= page.total) {
          const lastOffset = Math.max(0, Math.ceil(page.total / RUN_HISTORY_PAGE_SIZE) - 1) * RUN_HISTORY_PAGE_SIZE;
          this.historyRuns = [];
          this.runHistory = { ...this.runHistory, offset: lastOffset, total: page.total };
          this.paintRunHistory();
          page = await fetchRunHistory(repo, lastOffset);
          if (!current()) return;
        }
        this.historyRuns = page.runs;
        this.runHistory = { total: page.total, offset: page.offset, limit: page.limit, loading: false, error: null };
      } catch (error: unknown) {
        if (!current()) return;
        this.runHistory = { ...this.runHistory, loading: false, error: error instanceof Error ? error.message : 'Could not load history.' };
      }
      if (current()) this.paintRunHistory();
    })().finally(() => {
      if (this.runHistoryPending?.promise === promise) this.runHistoryPending = null;
    });
    this.runHistoryPending = { repo, offset, promise };
    return promise;
  }

  private paintRunHistory(): void {
    if (this.view !== 'runs') return;
    const panel = this.root.querySelector('[data-pane=recent]');
    if (!panel) return;
    const focused = document.activeElement;
    const focusInside = focused instanceof HTMLElement && panel.contains(focused);
    const direction = focusInside ? focused.dataset.runsPage : undefined;
    const retry = focusInside && focused.hasAttribute('data-runs-retry');
    const template = document.createElement('template');
    template.innerHTML = renderRunHistory(this.historyRuns, this.selectedRepo, this.runHistory);
    const next = template.content.firstElementChild;
    if (next) panel.replaceWith(next);
    this.paintRunRetries();
    if (focusInside) {
      const selector = direction === 'previous' || direction === 'next' ? `[data-runs-page="${direction}"]:not(:disabled)` : retry ? '[data-runs-retry]:not(:disabled)' : '.runs-pagination';
      (next?.querySelector<HTMLElement>(selector) ?? next?.querySelector<HTMLElement>('.runs-pagination'))?.focus({ preventScroll: true });
    }
  }

  private paintLocalRuns(): void {
    if (!this.snapshot || this.snapshotRepo !== this.selectedRepo || this.view !== 'dashboard') return;
    const next = document.createElement('div');
    renderDashboard(next, this.snapshot, new Date(), this.degraded, this.repos, this.selectedRepo,
      this.runs, this.autoClaimRepos, this.caps, this.themeId, this.rackLayout, this.jiraBaseUrl, this.repoPrs, this.jiraEnabled);
    const selectors = [...['underway', 'running', 'recent'].flatMap(panel =>
      ['.faceplate-body', '.faceplate-count', '.faceplate-lamp'].map(part => `[data-panel="${panel}"] ${part}`))];
    for (const selector of selectors) {
      const current = this.root.querySelector(selector);
      const replacement = next.querySelector(selector);
      if (current && replacement) current.replaceWith(replacement);
    }
  }

  private prInbox(): PrInboxState {
    const unavailable = this.dashboardUnavailable || this.degraded.includes('github');
    const authored = this.snapshotRepo === this.selectedRepo ? this.snapshot?.myOpenPrs ?? [] : [];
    return {
      reviewRequests: this.reviewRequests,
      authored: {
        prs: this.degraded.includes('github') ? [] : authored.filter(pr => !this.selectedRepo || pr?.repo?.toLowerCase() === this.selectedRepo.toLowerCase()),
        loading: !this.snapshot && !unavailable,
        degraded: unavailable,
        truncated: false,
      },
    };
  }

  private paintPrInbox(): void {
    if (this.view !== 'prs') return;
    const inbox: HTMLElement | null = this.root.querySelector('.pr-inbox');
    if (inbox) inbox.innerHTML = renderPrLists(this.prInbox(), this.selectedRepo);
    this.bindPaneLinks();
    this.paintSlackReviewRequests();
  }

  private loadReviewRequests(force: boolean = true): Promise<void> {
    if (!force && document.hidden) return Promise.resolve();
    if (this.reviewRequestsPending?.repo === this.selectedRepo && this.reviewRequestsPending.seq === this.reviewRequestsSeq) {
      return this.reviewRequestsPending.promise;
    }
    const repo = this.selectedRepo;
    if (!force && this.reviewRequestsRepo === repo && Date.now() - this.lastReviewRequestsRefresh < POLL_MS) return Promise.resolve();
    this.reviewRequestsRepo = repo;
    this.lastReviewRequestsRefresh = Date.now();
    const pending: Promise<void> = this.fetchReviewRequests().finally(() => {
      if (this.reviewRequestsPending?.promise === pending) this.reviewRequestsPending = null;
    });
    this.reviewRequestsPending = { repo, seq: this.reviewRequestsSeq, promise: pending };
    return pending;
  }

  private async fetchReviewRequests(): Promise<void> {
    const seq: number = ++this.reviewRequestsSeq;
    const repo = this.selectedRepo;
    this.reviewRequests = { ...this.reviewRequests, loading: true };
    this.paintPrInbox();
    const result = await fetchReviewRequests(repo);
    if (seq !== this.reviewRequestsSeq || repo !== this.selectedRepo || this.destroyed) return;
    this.reviewRequests = { ...result, loading: false };
    this.paintPrInbox();
  }

  private paintRepoPrs(): void {
    if (this.view !== 'dashboard') return;
    const panel: HTMLElement | null = this.root.querySelector('.faceplate[data-panel="repoprs"]');
    const body: HTMLElement | null = panel?.querySelector('.faceplate-body') ?? null;
    if (!body) return;
    body.innerHTML = renderRepoPrs(this.selectedRepo, this.repoPrs);
    const count: number = this.repoPrs.prs.filter((pr) => pr.repo === this.selectedRepo).length;
    const countEl: HTMLElement | null = panel?.querySelector('.faceplate-count') ?? null;
    if (countEl) countEl.textContent = String(count);
    const lamp: HTMLElement | null = panel?.querySelector('.faceplate-lamp') ?? null;
    lamp?.classList.toggle('lamp-queued', count > 0);
    lamp?.classList.toggle('lamp-idle', count === 0);
  }

  private loadRepoPrs(force: boolean = true): Promise<void> {
    if (!force && document.hidden) return Promise.resolve();
    if (this.repoPrsPending?.repo === this.selectedRepo && this.repoPrsPending.seq === this.repoPrsSeq) {
      return this.repoPrsPending.promise;
    }
    const repo: string | null = this.selectedRepo;
    if (!force && this.repoPrsRepo === repo && Date.now() - this.lastRepoPrsRefresh < POLL_MS) return Promise.resolve();
    this.repoPrsRepo = repo;
    this.lastRepoPrsRefresh = Date.now();
    const pending: Promise<void> = this.fetchRepoPrs().finally(() => {
      if (this.repoPrsPending?.promise === pending) this.repoPrsPending = null;
    });
    this.repoPrsPending = { repo, seq: this.repoPrsSeq, promise: pending };
    return pending;
  }

  private async fetchRepoPrs(): Promise<void> {
    const seq: number = ++this.repoPrsSeq;
    const repo: string | null = this.selectedRepo;
    if (!repo) {
      this.repoPrs = { prs: [], loading: false, degraded: false, truncated: false };
      this.paintRepoPrs();
      return;
    }
    this.repoPrs = { prs: this.repoPrs.prs.filter((pr) => pr.repo === repo), loading: true, degraded: false, truncated: false };
    this.paintRepoPrs();
    const result = await fetchRepoOpenPrs(repo);
    if (seq !== this.repoPrsSeq || repo !== this.selectedRepo) return;
    this.repoPrs = { ...result, loading: false };
    this.paintRepoPrs();
  }

  private paint(): void {
    const focused = document.activeElement;
    const focusedTab = focused instanceof HTMLAnchorElement && this.root.contains(focused) && focused.matches('.page-tab')
      ? focused.dataset.view : null;
    const sameView = this.root.querySelector<HTMLElement>('.helm')?.dataset.page === this.view;
    this.paintView();
    this.paintRunRetries();
    this.syncPirateToggle();
    if (focusedTab) {
      const view = sameView ? focusedTab : this.view;
      const tabs = Array.from(this.root.querySelectorAll<HTMLAnchorElement>('.page-tab'));
      tabs.forEach(tab => { tab.tabIndex = tab.dataset.view === view ? 0 : -1; });
      tabs.find(tab => tab.dataset.view === view)?.focus({ preventScroll: true });
    }
  }

  private paintView(): void {
    if (this.view === 'todos') {
      this.mountPage(renderTodosView(this.todos, { ...this.shellOptions(), autoClaimEnabled: this.autoClaimRepos.includes(this.selectedRepo ?? '') }));
      this.bindHeadControls();
      this.rehomeRunDrawer();
      return;
    }
    if (this.view === 'runs') {
      this.mountPage(renderRunsView(this.prView, { repos: this.repos, selectedRepo: this.selectedRepo, themeId: this.themeId, runs: this.historyRuns, history: this.runHistory }));
      this.bindHeadControls();
      this.rehomeRunDrawer();
      return;
    }
    if (this.view === 'outcomes') {
      this.mountPage(renderOutcomesView(this.outcomesState(), this.shellOptions()));
      this.bindHeadControls();
      this.rehomeRunDrawer();
      return;
    }
    if (this.view === 'campaigns') {
      const existing = this.root.querySelector<HTMLElement>('#campaigns-page');
      if (!existing || !this.campaigns) {
        this.campaigns?.destroy();
        this.mountPage(renderAppShell(this.shellOptions(), '<div id="campaigns-page"></div>'));
        const container = this.root.querySelector<HTMLElement>('#campaigns-page');
        if (container) {
          this.campaigns = mountCampaigns(container, {
            repo: () => this.selectedRepo,
            onOpenRun: runId => { void this.navigate({ ...this.route, view: 'runs', pane: 'tasks', run: runId }); },
          });
        }
      } else void this.campaigns.refresh();
      this.bindHeadControls();
      this.rehomeRunDrawer();
      return;
    }
    if (this.view === 'clarifications') {
      const existing = this.root.querySelector<HTMLElement>('#clarifications-page');
      if (!existing || !this.clarifications) {
        this.clarifications?.destroy();
        this.mountPage(renderAppShell(this.shellOptions(), '<div id="clarifications-page"></div>'));
        const container = this.root.querySelector<HTMLElement>('#clarifications-page');
        if (container) this.clarifications = mountClarifications(container, { repo: () => this.selectedRepo });
      } else void this.clarifications.refresh();
      this.bindHeadControls();
      this.rehomeRunDrawer();
      return;
    }
    if (this.view === 'cmux') {
      this.paintCmux();
      return;
    }
    if (this.view === 'triage') {
      this.paintTriage();
      return;
    }
    if (this.view === 'bugs') {
      this.paintBugs();
      return;
    }
    if (this.view === 'config') {
      this.paintConfig();
      return;
    }
    if (this.view === 'prs') {
      this.paintPrView();
      return;
    }
    if (!this.snapshot || this.snapshotRepo !== this.selectedRepo) {
      this.mountPage(renderAppShell(this.shellOptions(), `<div class="empty-note" role="status">${this.dashboardUnavailable ? term('unavailableDashboard') : `Loading ${term('dashboard')}…`}</div>`));
      return;
    }
    const preBody: HTMLElement | null =
      this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    const savedScrollTop: number = preBody ? preBody.scrollTop : 0;
    const newRun = this.root.querySelector('.newrun-body');
    const preserveNewRun = this.contentView === 'dashboard' && this.newRunRepoScope === this.selectedRepo;
    const focused = document.activeElement;
    const fields = preserveNewRun ? Array.from(newRun?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') ?? [])
      .map(input => ({
        selector: `.${input.classList[0]}`,
        value: input.value,
        checked: input instanceof HTMLInputElement && input.type === 'radio' ? input.checked : undefined,
        focused: input === focused,
        selection: input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && input.type === 'text')
          ? [input.selectionStart, input.selectionEnd] as const : null,
      })) : [];
    const page = document.createElement('div');
    renderDashboard(
      page,
      this.snapshot,
      new Date(),
      this.degraded,
      this.repos,
      this.selectedRepo,
      this.runs,
      this.autoClaimRepos,
      this.caps,
      this.themeId,
      this.rackLayout,
      this.jiraBaseUrl,
      this.repoPrs,
      this.jiraEnabled,
    );
    this.mountPage(page.innerHTML);
    this.newRunRepoScope = this.selectedRepo;
    for (const field of fields) {
      const controls = this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(field.selector);
      const input = field.checked === undefined ? controls[0] : Array.from(controls).find(control => control.value === field.value);
      if (!input) continue;
      if (field.checked !== undefined && input instanceof HTMLInputElement) input.checked = field.checked;
      else if (!(input instanceof HTMLSelectElement) || Array.from(input.options).some(option => option.value === field.value)) input.value = field.value;
      if (field.focused) {
        input.focus({ preventScroll: true });
        if (field.selection && !(input instanceof HTMLSelectElement)) input.setSelectionRange(...field.selection);
      }
    }
    const launch = this.root.querySelector<HTMLButtonElement>('.newrun-launch');
    if (launch) launch.disabled = this.newRunPending;
    this.bindHeadControls();
    this.bindRackDnD();
    this.rehomeRunDrawer();
    const postBody: HTMLElement | null =
      this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    if (postBody) {
      postBody.scrollTop = this.stickToBottom ? postBody.scrollHeight : savedScrollTop;
    }
  }

  private revealActiveTab(): void {
    const tabs = this.root.querySelector<HTMLElement>('.page-tabs');
    const activeTab = tabs?.querySelector<HTMLElement>('.page-tab.is-active');
    if (tabs && activeTab) {
      const right = activeTab.offsetLeft + activeTab.offsetWidth;
      if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
      else if (activeTab.offsetLeft < tabs.scrollLeft) tabs.scrollLeft = activeTab.offsetLeft;
    }
  }

  private shellOptions(): HelmHeadOpts {
    const snapshot = this.snapshotRepo === this.selectedRepo ? this.snapshot : null;
    return {
      active: this.view, repos: this.repos, selectedRepo: this.selectedRepo, themeId: this.themeId,
      jiraEnabled: this.jiraEnabled,
      greetingName: this.greetingName,
      readout: {
        running: this.runs.filter(run => run?.status === 'running' && (!this.selectedRepo || run.repo === this.selectedRepo)).length,
        queued: snapshot && !this.degraded.includes('jira') ? snapshot.queue?.length ?? null : null,
        review: snapshot && !this.degraded.includes('jira') ? snapshot.stats?.awaitingReview ?? null : null,
      },
    };
  }

  private mountPage(markup: string): void {
    if (this.contentView === 'config') this.captureConfigDrafts();
    const template = document.createElement('template');
    template.innerHTML = markup;
    const next = template.content.querySelector('#page-content');
    if (!next) return;
    if (!this.root.querySelector('.helm-head')) {
      this.root.innerHTML = renderAppShell(this.shellOptions(), '');
      this.paintSlack();
    }
    const content = this.root.querySelector<HTMLElement>('#page-content');
    const expandedTickets = new Set(Array.from(content?.querySelectorAll<HTMLDetailsElement>('details[data-ticket-description][open]') ?? [], detail => detail.dataset.ticketDescription));
    content?.replaceChildren(...next.childNodes);
    content?.querySelectorAll<HTMLDetailsElement>('details[data-ticket-description]').forEach(detail => {
      detail.open = expandedTickets.has(detail.dataset.ticketDescription);
    });
    if (content && this.contentView !== this.view) content.scrollTop = 0;
    this.contentView = this.view;
    this.syncShell();
    this.paintSlackReviewRequests();
  }

  private syncShell(): void {
    const shell = this.root.querySelector<HTMLElement>('.helm');
    if (!shell) return;
    const opts = this.shellOptions();
    shell.dataset.page = this.view;
    shell.className = `helm${this.view === 'dashboard' ? '' : ` ${this.view}-view`}`;
    this.root.querySelector('#page-content')?.setAttribute('aria-labelledby', `page-tab-${this.view}`);
    const template = document.createElement('template');
    template.innerHTML = renderHelmHead(opts);
    const repo = shell.querySelector<HTMLSelectElement>('.repo-select');
    const nextRepo = template.content.querySelector<HTMLSelectElement>('.repo-select');
    if (repo && nextRepo) {
      if (repo.innerHTML !== nextRepo.innerHTML) repo.innerHTML = nextRepo.innerHTML;
      repo.value = this.selectedRepo ?? '';
      repo.setAttribute('aria-label', nextRepo.getAttribute('aria-label') ?? '');
    }
    const tabs = shell.querySelector('.page-tabs');
    const nextTabs = template.content.querySelector('.page-tabs');
    const tabIds = (node: Element | null) => Array.from(node?.querySelectorAll('.page-tab') ?? []).map(tab => tab.id).join(',');
    if (tabs && nextTabs && tabIds(tabs) !== tabIds(nextTabs)) tabs.replaceChildren(...nextTabs.childNodes);
    for (const next of template.content.querySelectorAll<HTMLAnchorElement>('.page-tab')) {
      const tab = shell.querySelector<HTMLAnchorElement>(`#${next.id}`);
      if (!tab) continue;
      tab.className = next.className;
      tab.textContent = next.textContent;
      for (const name of ['href', 'aria-selected', 'aria-current']) {
        const value = next.getAttribute(name);
        if (value === null) tab.removeAttribute(name);
        else tab.setAttribute(name, value);
      }
      if (!shell.querySelector('.page-tabs')?.contains(document.activeElement)) tab.tabIndex = next.tabIndex;
    }
    for (const next of template.content.querySelectorAll<HTMLElement>('[data-fleet-count]')) {
      const count = shell.querySelector<HTMLElement>(`[data-fleet-count="${next.dataset.fleetCount}"]`);
      if (!count) continue;
      count.textContent = next.textContent;
      if (next.hasAttribute('title')) count.setAttribute('title', next.title);
      else count.removeAttribute('title');
    }
    shell.querySelector('.helm-readout')?.setAttribute('aria-label', term('systemStatus'));
    for (const label of template.content.querySelectorAll<HTMLElement>('[data-readout-label]')) {
      const current = shell.querySelector(`[data-readout-label="${label.dataset.readoutLabel}"]`);
      if (current) current.textContent = label.textContent;
    }
    const repos = shell.querySelector('[data-footer-repos]');
    if (repos) repos.textContent = `${this.repos.length} ${term(this.repos.length === 1 ? 'repository' : 'repositories').toLowerCase()} tracked`;
    const running = shell.querySelector('[data-footer-running]');
    if (running) running.textContent = `${opts.readout?.running ?? '—'} ${term('running').toLowerCase()}`;
    const nextGreeting = template.content.querySelector('[data-greeting]');
    const greeting = shell.querySelector('[data-greeting]');
    if (nextGreeting && greeting) greeting.replaceWith(nextGreeting);
    else if (nextGreeting) shell.querySelector('.nameplate-scope')?.append(nextGreeting);
  }

  private bindHeadControls(): void {
    this.revealActiveTab();
    this.bindPaneLinks();
  }

  private paintSlack(): void {
    const controls = this.root.querySelector('.helm-controls');
    if (!controls) return;
    let center = controls.querySelector<HTMLElement>('.slack-center');
    if (!center) {
      center = document.createElement('div');
      center.className = 'slack-center';
      controls.append(center);
    }
    const focused = document.activeElement;
    const focusReadId = focused instanceof HTMLElement && center.contains(focused) ? focused.dataset.slackRead : undefined;
    const focusToggle = focused instanceof HTMLElement && center.contains(focused) && focused.hasAttribute('data-slack-toggle');
    const scrollTop = center.querySelector('.slack-popover')?.scrollTop ?? 0;
    const template = document.createElement('template');
    template.innerHTML = renderSlack(this.slack, this.slackOpen, this.slackError, undefined, this.selectedRepo);
    const nextToggle = template.content.querySelector<HTMLButtonElement>('[data-slack-toggle]');
    const nextPopover = template.content.querySelector<HTMLElement>('.slack-popover');
    const toggle = center.querySelector<HTMLButtonElement>('[data-slack-toggle]');
    const currentPopover = center.querySelector<HTMLElement>('.slack-popover');
    if (!toggle || !currentPopover || !nextToggle || !nextPopover) center.replaceChildren(...template.content.childNodes);
    else {
      toggle.className = nextToggle.className;
      toggle.setAttribute('aria-expanded', nextToggle.getAttribute('aria-expanded') ?? 'false');
      toggle.setAttribute('aria-label', nextToggle.getAttribute('aria-label') ?? 'Notifications');
      if (toggle.innerHTML !== nextToggle.innerHTML) toggle.innerHTML = nextToggle.innerHTML;
      currentPopover.hidden = nextPopover.hidden;
      if (currentPopover.innerHTML !== nextPopover.innerHTML) currentPopover.innerHTML = nextPopover.innerHTML;
    }
    const popover = center.querySelector('.slack-popover');
    if (popover) popover.scrollTop = scrollTop;
    for (const button of center.querySelectorAll<HTMLButtonElement>('[data-slack-read]')) {
      button.disabled = this.slackReads.has(button.dataset.slackRead ?? '');
    }
    if (focusReadId !== undefined) {
      const button = Array.from(center.querySelectorAll<HTMLButtonElement>('[data-slack-read]')).find(item => item.dataset.slackRead === focusReadId);
      (button ?? center.querySelector<HTMLButtonElement>('[data-slack-toggle]'))?.focus({ preventScroll: true });
    } else if (focusToggle) center.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus({ preventScroll: true });
  }

  private paintSlackReviewRequests(): void {
    for (const control of this.root.querySelectorAll<HTMLElement>('[data-slack-review-control]')) {
      const repo = control.dataset.repo;
      const number = Number(control.dataset.number);
      if (!repo || !Number.isSafeInteger(number)) continue;
      const key = `${repo.toLowerCase()}#${number}`;
      const state = this.slackReviewRequests.get(key);
      const saved = this.slackReviewHistory.get(key);
      const button = control.querySelector<HTMLButtonElement>('[data-slack-review-request]');
      const status = control.querySelector<HTMLElement>('.slack-review-result');
      if (!button || !status) continue;
      const disabled = String(this.uiConfig.config?.SLACK_ENABLED) === 'false';
      const pending = state?.pending || !state && saved?.status === 'pending';
      const sent = state?.result || !state && saved?.status === 'sent';
      const canRepeat = canRequestSlackAgain(state, saved);
      const uncertain = !state && saved?.status === 'uncertain';
      const error = state?.error ?? (uncertain ? 'Delivery unconfirmed. Check Slack before requesting again.'
        : !state && saved?.status === 'failed' ? 'The last Slack request failed. You can retry.' : undefined);
      button.disabled = disabled || Boolean(control.dataset.unavailable || pending || sent && !canRepeat || uncertain);
      button.title = disabled ? 'Enable Slack integration in Config to request a review.' : control.dataset.unavailable ?? '';
      button.textContent = pending ? 'Sending…' : canRepeat ? term('requestSlackReviewAgain') : sent ? term('reviewRequested') : term('requestSlackReview');
      status.classList.toggle('is-error', Boolean(error));
      status.setAttribute('role', error ? 'alert' : 'status');
      status.replaceChildren();
      if (error) status.textContent = error;
      else if (state?.result) status.textContent = `Sent to #${state.result.channel.replace(/^#/, '')}. `;
      else if (pending) status.textContent = 'A request is already in progress. ';
      else if (sent) status.textContent = 'Review requested in Slack. ';
      else if (this.slackReviewHistoryUnavailable) status.textContent = 'Request history unavailable. ';
      const sentAt = state?.result?.sentAt ?? saved?.lastSentAt;
      if (sentAt && Number.isFinite(Date.parse(sentAt))) {
        const time = document.createElement('time');
        time.dateTime = sentAt;
        time.title = new Date(sentAt).toLocaleString();
        time.textContent = `Last requested ${formatRelativeTime(sentAt, new Date())}. `;
        status.append(' ', time);
      } else if (sent) status.append('Request time unavailable. ');
      const permalink = state?.result?.permalink ?? saved?.permalink;
      if (permalink) {
        const link = document.createElement('a');
        link.href = permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View message ↗';
        status.append(link);
      }
    }
  }

  private async sendSlackReviewRequest(button: HTMLButtonElement): Promise<void> {
    const repo = button.dataset.repo;
    const number = Number(button.dataset.number);
    if (!repo || !Number.isSafeInteger(number) || number < 1) return;
    const key = `${repo.toLowerCase()}#${number}`;
    const previous = this.slackReviewRequests.get(key);
    const saved = this.slackReviewHistory.get(key);
    const canRepeat = canRequestSlackAgain(previous, saved);
    if (previous?.pending || previous?.result && !canRepeat) return;
    if (!previous && saved && saved.status !== 'failed' && !canRepeat) return;
    const state: SlackReviewUiState = { requestId: !canRepeat && previous?.requestId || crypto.randomUUID(), requestedAt: new Date().toISOString(), pending: true };
    this.slackReviewRequests.set(key, state);
    this.paintSlackReviewRequests();
    try {
      state.result = await requestSlackReview(repo, number, state.requestId);
      this.slackReviewHistory.set(key, { requestId: state.requestId, repo, prNumber: number, status: 'sent',
        lastRequestedAt: state.requestedAt, lastSentAt: state.result.sentAt ?? null, permalink: state.result.permalink, error: null });
    } catch (error: unknown) {
      state.error = error instanceof Error ? error.message : 'Slack request failed. Check the channel before retrying.';
      if (error instanceof SlackReviewRequestError && !error.uncertain) state.requestId = '';
    } finally {
      state.pending = false;
      if (!this.destroyed) this.paintSlackReviewRequests();
    }
  }

  private async readSlackNotification(id: string): Promise<void> {
    if (this.slackReads.has(id)) return;
    this.slackReads.add(id);
    this.slackError = null;
    this.paintSlack();
    const ok = await markSlackNotificationRead(id);
    this.slackReads.delete(id);
    if (ok) {
      ++this.slackSeq;
      this.slack = { ...this.slack, notifications: this.slack.notifications.map(item => item.id === id ? { ...item, readAt: new Date().toISOString() } : item) };
    } else this.slackError = 'Could not mark notification read. Try again.';
    this.paintSlack();
  }

  private handleRackKeyboardMove(handle: HTMLButtonElement, event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const panel = handle.dataset.panel as PanelId | undefined;
    if (!panel) return;
    const column = this.rackLayout.findIndex(slots => slots.some(slot => slot.panels.includes(panel)));
    const slots = this.rackLayout[column];
    const index = slots?.findIndex(slot => slot.panels.includes(panel)) ?? -1;
    if (!slots || index < 0) return;
    event.preventDefault();
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const targetColumn = horizontal ? column + (event.key === 'ArrowLeft' ? -1 : 1) : column;
    const targetSlots = this.rackLayout[targetColumn];
    if (!targetSlots) return;
    const targetIndex = horizontal ? targetSlots.length : Math.max(0, Math.min(slots.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    if (targetColumn === column && targetIndex === index) return;
    this.rackLayout = movePanel(this.rackLayout, panel, targetColumn, targetIndex);
    saveRackLayoutRaw(serializeRack(this.rackLayout));
    this.paint();
    this.root.querySelector<HTMLButtonElement>(`.rack-handle[data-panel="${panel}"]`)?.focus();
  }

  private bindRackDnD(): void {
    this.root.querySelectorAll<HTMLElement>('.rack-handle').forEach((handle) => {
      handle.addEventListener('dragstart', (event: DragEvent): void => {
        const panel: string | undefined = handle.dataset.panel;
        if (!panel || !event.dataTransfer) return;
        event.dataTransfer.setData('text/helmsman-panel', panel);
        event.dataTransfer.effectAllowed = 'move';
        handle.closest('.faceplate')?.classList.add('is-dragging');
      });
      handle.addEventListener('dragend', (): void => {
        this.root.querySelectorAll('.faceplate.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-drop]').forEach((target) => {
      target.addEventListener('dragover', (event: DragEvent): void => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        target.classList.add('is-drop-target');
      });
      target.addEventListener('dragleave', (): void => target.classList.remove('is-drop-target'));
      target.addEventListener('drop', (event: DragEvent): void => {
        event.preventDefault();
        target.classList.remove('is-drop-target');
        this.handleRackDrop(target, event);
      });
    });
  }

  private handleRackDrop(target: HTMLElement, event: DragEvent): void {
    const panel = (event.dataTransfer?.getData('text/helmsman-panel') ?? '') as PanelId | '';
    if (!panel) return;
    const kind: string | undefined = target.dataset.drop;
    let next: RackLayout;
    if (kind === 'head') {
      next = stackOnto(this.rackLayout, panel, target.dataset.panel as PanelId);
    } else if (kind === 'end') {
      next = movePanel(this.rackLayout, panel, Number(target.dataset.col), Number.MAX_SAFE_INTEGER);
    } else {
      next = movePanel(this.rackLayout, panel, Number(target.dataset.col), Number(target.dataset.slot));
    }
    this.rackLayout = next;
    saveRackLayoutRaw(serializeRack(next));
    this.paint();
  }

  private paintCmux(): void {
    this.mountPage(renderCmuxView({
      connected: this.cmuxConnected,
      error: this.cmuxTabsError,
      tabs: this.cmuxTabs,
      selectedSurface: this.cmuxPanelState.selectedSurface,
      screen: this.cmuxScreen,
      isCapturing: this.cmuxCapturing,
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      themeId: this.themeId,
      collapsed: this.collapsed,
    }));
    this.bindHeadControls();
  }

  private paintTriage(): void {
    const now = Date.now();
    for (const [column, group] of [['backlog', 'unassignedBacklog'], ['todo', 'unassignedTodo'], ['mine', 'mineOpen']] as const) {
      this.triagePages[column] = paginateTriageTickets(filterTriageTickets(this.triageGroups?.[group], this.triageFilters, now), this.triagePageSize, this.triagePages[column]).page;
    }
    this.mountPage(renderTriageView(this.triageGroups, {
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      jiraBaseUrl: this.jiraBaseUrl,
      degraded: this.triageDegraded,
      filters: this.triageFilters,
      pageSize: this.triagePageSize,
      pages: this.triagePages,
      themeId: this.themeId,
      collapsed: this.collapsed,
    }));
    this.bindHeadControls();
    this.rehomeRunDrawer();
  }

  private async loadTriage(): Promise<void> {
    const seq = ++this.triageSeq;
    const repo = this.selectedRepo;
    const res = await fetchTriage(repo);
    if (seq !== this.triageSeq || repo !== this.selectedRepo) return;
    this.triageGroups = res.groups;
    this.triageDegraded = res.degraded;
    if (res.jiraBaseUrl) this.jiraBaseUrl = res.jiraBaseUrl;
  }

  private paintBugs(): void {
    this.mountPage(renderBugsView(
      this.bugsResponse ?? { cards: [], degraded: true, generatedAt: '', latestWindow: '', previousWindow: '' },
      { repos: this.repos, selectedRepo: this.selectedRepo, themeId: this.themeId },
    ));
    this.bindHeadControls();
  }

  private async loadBugs(): Promise<void> {
    const seq = ++this.bugsSeq;
    const repo = this.selectedRepo;
    const result = await fetchBugs(repo);
    if (seq !== this.bugsSeq || repo !== this.selectedRepo) return;
    this.bugsResponse = result;
  }

  private outcomesState(): OutcomesViewState {
    return { summary: this.outcomes, days: this.outcomeDays, loading: this.outcomesLoading, error: this.outcomesError, savingRunId: this.outcomesSavingRunId };
  }

  private async loadOutcomes(): Promise<void> {
    const seq = ++this.outcomesSeq;
    const repo = this.selectedRepo;
    this.outcomesLoading = true;
    this.outcomesError = null;
    if (!this.outcomesEditing && !this.outcomesSavingRunId) this.paint();
    try {
      const summary = await fetchOutcomes(repo, this.outcomeDays);
      if (seq !== this.outcomesSeq || repo !== this.selectedRepo || this.view !== 'outcomes') return;
      this.outcomes = summary;
    } catch (error: unknown) {
      if (seq !== this.outcomesSeq || repo !== this.selectedRepo || this.view !== 'outcomes') return;
      this.outcomesError = error instanceof Error ? error.message : 'Could not load outcomes.';
    } finally {
      if (seq !== this.outcomesSeq || this.destroyed) return;
      this.outcomesLoading = false;
      if (!this.outcomesEditing && !this.outcomesSavingRunId) this.paint();
    }
  }

  private paintLocalGit(): void {
    if (this.view !== 'config') return;
    const card = this.root.querySelector('.local-git-panel');
    if (card) card.outerHTML = renderLocalGit(this.localGit);
  }

  private loadLocalGit(): Promise<void> {
    const repo = this.selectedRepo;
    if (!repo) {
      this.localGit = emptyLocalGit(null);
      this.paintLocalGit();
      return Promise.resolve();
    }
    const operation = this.localGitOperations.get(repo);
    if (operation) {
      const seq = this.localGitSeq;
      this.localGit = { ...this.localGit, loading: true, pendingAction: 'Waiting for the local Git operation…' };
      this.paintLocalGit();
      return operation.then(() => {
        if (seq === this.localGitSeq && repo === this.selectedRepo) return this.loadLocalGit();
      });
    }
    if (this.localGitPending?.repo === repo) return this.localGitPending.promise;
    const seq = ++this.localGitSeq;
    this.localGit = { ...(this.localGit.repo === repo ? this.localGit : emptyLocalGit(repo)), loading: true, confirmation: undefined, cleanup: undefined, pendingAction: undefined };
    this.paintLocalGit();
    const promise = fetchLocalGit(repo).then(result => {
      if (seq !== this.localGitSeq || repo !== this.selectedRepo) return;
      this.localGit = result;
      this.paintLocalGit();
    }).finally(() => {
      if (this.localGitPending?.promise === promise) this.localGitPending = null;
    });
    this.localGitPending = { repo, promise };
    return promise;
  }

  private confirmLocalGitDeletion(button: HTMLButtonElement): void {
    if (button.disabled || this.localGit.loading || this.localGit.pendingAction || this.localGit.repo !== this.selectedRepo) return;
    const branchName = button.dataset.localBranch;
    const worktreePath = button.dataset.localWorktree;
    const branch = this.localGit.branches.find(item => item?.name === branchName);
    const tree = this.localGit.worktrees.find(item => item?.path === worktreePath);
    if (branch && !branch.current && !branch.deletionBlockedReason) {
      this.localGit = { ...this.localGit, cleanup: undefined, confirmation: { action: 'delete-branch', branch: branch.name, expectedCommit: branch.commit } };
    } else if (tree && !tree.locked && !tree.bare && tree.path !== this.localGit.path && !tree.deletionBlockedReason) {
      this.localGit = { ...this.localGit, cleanup: undefined, confirmation: { action: 'delete-worktree', path: tree.path, expectedCommit: tree.commit } };
    } else return;
    this.paintLocalGit();
    this.root.querySelector<HTMLButtonElement>('.local-git-cancel')?.focus();
  }

  private mutateLocalGit(action: LocalGitAction): Promise<void> {
    const repo = this.selectedRepo;
    if (!repo || this.localGit.repo !== repo || this.localGit.loading || this.localGit.pendingAction || this.localGitOperations.has(repo)) return Promise.resolve();
    const seq = ++this.localGitSeq;
    this.localGit = { ...this.localGit, confirmation: undefined, cleanup: undefined, error: null,
      pendingAction: action.action === 'refresh-remotes' ? 'Fetching remote status…'
        : action.action === 'preview-delete-untracked-branches' ? 'Checking eligible branches…' : 'Deleting…' };
    this.paintLocalGit();
    const promise = updateLocalGit(repo, action).then(result => {
      if (seq !== this.localGitSeq || repo !== this.selectedRepo) return;
      this.localGit = result;
      this.paintLocalGit();
    }).finally(() => {
      if (this.localGitOperations.get(repo) === promise) this.localGitOperations.delete(repo);
    });
    this.localGitOperations.set(repo, promise);
    return promise;
  }

  private captureConfigDrafts(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('.config-row[data-key]')) {
      const key = row.dataset.key;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      if (!key || !input || input.dataset.configValue === undefined) continue;
      if (input.value !== input.dataset.configValue) this.configDrafts.set(key, input.value);
      else this.configDrafts.delete(key);
    }
  }

  private async loadUiConfig(paint = true): Promise<void> {
    if (this.configPendingKeys.size > 0) return;
    const seq = ++this.configSeq;
    this.configLoading = true;
    if (paint && this.view === 'config') this.paintConfig();
    const config = await getConfig();
    if (seq !== this.configSeq || this.destroyed) return;
    this.configLoading = false;
    if (config) {
      this.uiConfig = config;
      this.configLoaded = true;
      this.configError = null;
    } else {
      this.configError = 'Settings could not be loaded. Check the Helmsman connection and retry. Unsaved changes are kept.';
    }
    if (paint && this.view === 'config') this.paintConfig();
  }

  private paintConfig(): void {
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement
      ? focused.closest<HTMLElement>('.config-row')?.dataset.key : undefined;
    const selection = focused instanceof HTMLInputElement && focused.type === 'text'
      ? [focused.selectionStart, focused.selectionEnd] as const : null;
    this.mountPage(renderConfigView(this.uiConfig, {
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      themeId: this.themeId,
      localGit: this.localGit,
      loading: this.configLoading,
      error: this.configError,
      unavailable: !this.configLoaded,
    }));
    for (const row of this.root.querySelectorAll<HTMLElement>('.config-row[data-key]')) {
      const key = row.dataset.key;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
      if (!key || !input) continue;
      input.dataset.configValue = input.value;
      const draft = this.configDrafts.get(key);
      if (draft !== undefined) input.value = draft;
      const error = this.configErrors.get(key);
      const errorEl = row.querySelector('.config-error');
      if (errorEl) errorEl.textContent = error ?? '';
      if (error) input.setAttribute('aria-invalid', 'true');
      const button = row.querySelector<HTMLButtonElement>('.config-save');
      if (button) button.disabled = this.configPendingKeys.has(key);
      if (focusKey === key) {
        input.focus({ preventScroll: true });
        if (selection && input instanceof HTMLInputElement && input.type === 'text') input.setSelectionRange(...selection);
      }
    }
    this.bindHeadControls();
  }

  private paintTodoList(): void {
    if (this.view !== 'todos' || this.destroyed) return;
    const list = this.root.querySelector('[data-todo-list]');
    if (list) list.innerHTML = renderTodoList(this.todos, this.shellOptions());
    const autoClaim = this.root.querySelector<HTMLButtonElement>('[data-todo-auto-claim]');
    if (autoClaim) {
      const enabled = this.autoClaimRepos.includes(this.selectedRepo ?? '');
      autoClaim.setAttribute('aria-pressed', String(enabled));
      autoClaim.textContent = enabled ? 'Stop automatic starts' : 'Start todos automatically';
    }
    const feedback = this.root.querySelector('[data-todo-feedback]');
    if (feedback) {
      const template = document.createElement('template');
      template.innerHTML = renderTodosView(this.todos, this.shellOptions());
      const next = template.content.querySelector('[data-todo-feedback]');
      if (next) feedback.replaceChildren(...next.childNodes);
    }
  }

  private async loadTodos(force: boolean = false): Promise<void> {
    if (this.todos.pendingAction && !force) return;
    const seq = ++this.todosSeq;
    this.todos.loading = true;
    try {
      const result = await fetchTodos();
      if (seq !== this.todosSeq || this.destroyed) return;
      this.jiraEnabled = result.jiraEnabled;
      this.todos.items = result.todos;
      this.todos.error = null;
      this.repos = [...new Set([...this.repos, ...result.todos.map(todo => todo.repo)])].sort();
      if (this.jiraEnabled && this.view === 'todos') {
        await this.navigate({ ...this.route, view: 'config', pane: null }, 'replace');
        return;
      }
    } catch (error: unknown) {
      if (seq !== this.todosSeq || this.destroyed) return;
      this.todos.error = error instanceof Error ? error.message : 'Unable to load todos.';
    } finally {
      if (seq === this.todosSeq && !this.destroyed) {
        this.todos.loading = false;
        this.paintTodoList();
        this.syncShell();
      }
    }
  }

  private async saveTodo(form: HTMLFormElement): Promise<void> {
    if (this.todos.pendingAction || this.jiraEnabled) return;
    ++this.todosSeq;
    this.todos.loading = false;
    const input = readTodoForm(form);
    const id = this.todos.editingId;
    this.todos.draft = input;
    this.todos.pendingAction = 'Saving todo…';
    this.todos.error = null;
    this.paint();
    try {
      const todo = id ? await updateTodo(id, input) : await createTodo(input);
      this.todos.items = [...this.todos.items.filter(item => item.id !== todo.id), todo];
      this.todos.editingId = null;
      this.todos.draft = undefined;
      this.repos = [...new Set([...this.repos, todo.repo])].sort();
      this.lastDashboardRefresh = -Infinity;
    } catch (error: unknown) {
      this.todos.error = error instanceof Error ? error.message : 'Unable to save todo.';
    } finally {
      this.todos.pendingAction = undefined;
      if (!this.destroyed && this.view === 'todos') this.paint();
    }
  }

  private async handleTodoAction(button: HTMLButtonElement): Promise<void> {
    if (this.todos.pendingAction || this.jiraEnabled) return;
    if (button.hasAttribute('data-todo-auto-claim')) {
      const repo = this.selectedRepo;
      if (!repo) return;
      const enabled = !this.autoClaimRepos.includes(repo);
      this.todos.pendingAction = 'Updating auto-claim…';
      this.todos.error = null;
      this.paint();
      try {
        await setAutoClaim(repo, enabled);
        this.autoClaimRepos = [...this.autoClaimRepos.filter(item => item !== repo), ...(enabled ? [repo] : [])];
      } catch (error: unknown) {
        this.todos.error = error instanceof Error ? error.message : 'Unable to update auto-claim.';
      } finally {
        this.todos.pendingAction = undefined;
        if (!this.destroyed && this.view === 'todos') this.paint();
      }
      return;
    }
    const { todoEdit, todoDelete, todoConfirmDelete, todoLaunch } = button.dataset;
    if (button.hasAttribute('data-todo-refresh')) {
      await this.loadTodos();
      return;
    }
    if (todoEdit) {
      const todo = this.todos.items.find(item => item.id === todoEdit);
      if (!todo || todo.state === 'in_progress') return;
      this.todos.editingId = todo.id;
      this.todos.draft = { ...todo };
      this.todos.deletingId = null;
      this.todos.error = null;
      this.paint();
      this.root.querySelector<HTMLInputElement>('[data-todo-form] [name=title]')?.focus();
      return;
    }
    if (todoDelete || button.hasAttribute('data-todo-cancel-delete')) {
      this.todos.deletingId = todoDelete ?? null;
      this.paintTodoList();
      return;
    }
    if (button.hasAttribute('data-todo-new') || button.hasAttribute('data-todo-cancel')) {
      this.todos.editingId = null;
      this.todos.draft = undefined;
      this.todos.error = null;
      this.paint();
      return;
    }
    if (!todoConfirmDelete && !todoLaunch) return;
    const todo = this.todos.items.find(item => item.id === (todoConfirmDelete ?? todoLaunch));
    if (!todo || todo.state === 'in_progress') return;
    if (todoConfirmDelete && this.todos.deletingId !== todo.id) return;
    ++this.todosSeq;
    this.todos.loading = false;
    this.todos.pendingAction = todoConfirmDelete ? 'Deleting todo…' : term('launchingRun');
    this.todos.error = null;
    this.paint();
    try {
      if (todoConfirmDelete) {
        await deleteTodo(todo.id);
        this.todos.items = this.todos.items.filter(item => item.id !== todo.id);
        this.todos.deletingId = null;
        if (this.todos.editingId === todo.id) {
          this.todos.editingId = null;
          this.todos.draft = undefined;
        }
      } else {
        const result = await launchRun({ mode: 'todo', todoId: todo.id, repo: todo.repo });
        if (!this.destroyed) this.openRunTab(result.runId, todo.id);
        await this.loadTodos(true);
      }
      this.lastDashboardRefresh = -Infinity;
    } catch (error: unknown) {
      this.todos.error = error instanceof Error ? error.message : 'Todo action failed.';
    } finally {
      this.todos.pendingAction = undefined;
      if (!this.destroyed && this.view === 'todos') this.paint();
    }
  }

  private paintPrView(): void {
    this.mountPage(renderPrView(this.prView, {
      repos: this.repos,
      selectedRepo: this.selectedRepo,
      themeId: this.themeId,
      lists: this.prInbox(),
      runs: this.runs,
    }));
    this.bindHeadControls();
    this.rehomeRunDrawer();
  }

  private async loadCmuxTabs(): Promise<void> {
    const seq = ++this.cmuxTabsSeq;
    try {
      const res: Response = await fetch('/api/cmux/tabs', { signal: AbortSignal.timeout(10_000) });
      const data = res.ok ? parseCmuxTabs(await res.json()) : null;
      if (seq !== this.cmuxTabsSeq || this.destroyed) return;
      if (!data) throw new Error('Terminal tabs unavailable');
      this.cmuxConnected = data.connected;
      this.cmuxTabs = data.tabs;
      this.cmuxTabsError = null;
    } catch {
      if (seq !== this.cmuxTabsSeq || this.destroyed) return;
      this.cmuxTabsError = 'Terminal tabs could not be refreshed. Check the Helmsman connection and try again.';
      return;
    }
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    const stillExists: boolean = surface !== null && this.cmuxTabs.some((t) => t.surfaceRef === surface);
    if (surface !== null && !stillExists) {
      this.cmuxPanelState = { selectedSurface: null };
      this.cmuxScreen = '';
    }
  }

  private ensureCmuxEvents(): void {
    if (this.cmuxEventSource) return;
    const src: EventSource = new EventSource('/api/cmux/events');
    src.onmessage = (m: MessageEvent<string>): void => {
      let msg: CmuxEventPayload = {};
      try {
        msg = JSON.parse(m.data) as CmuxEventPayload;
      } catch {
        return;
      }
      if (msg?.kind === 'cmux-tabs-changed') void this.handleCmuxTabsChanged();
    };
    this.cmuxEventSource = src;
  }

  private cmuxSnapshotSignature(): string {
    const tabsPart: string = this.cmuxTabs
      .map((t) => `${t.surfaceRef}${t.surfaceTitle}${t.workspaceTitle}${t.type}`)
      .join('');
    return JSON.stringify([this.cmuxConnected, this.cmuxTabsError, tabsPart]);
  }

  private async handleCmuxTabsChanged(): Promise<void> {
    if (document.hidden || this.view !== 'cmux') return;
    const prevSignature: string = this.cmuxSnapshotSignature();
    await this.loadCmuxTabs();
    if (this.view !== 'cmux') return;
    if (this.cmuxSnapshotSignature() !== prevSignature) {
      this.repaintCmuxPreservingInput();
    }
    this.syncCmuxPolling();
  }

  private repaintCmuxPreservingInput(): void {
    const prevInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.cmux-input');
    const hadFocus: boolean = document.activeElement === prevInput;
    const screenFocused = document.activeElement === this.root.querySelector('.cmux-screen');
    const previousSurface = this.root.querySelector<HTMLElement>('.cmux-tab.is-selected')?.dataset.surface;
    const value: string = prevInput?.value ?? '';
    const selectionStart: number | null = prevInput?.selectionStart ?? null;
    const selectionEnd: number | null = prevInput?.selectionEnd ?? null;

    this.paint();

    if (!previousSurface || previousSurface !== this.cmuxPanelState.selectedSurface) return;
    if (screenFocused) this.root.querySelector<HTMLElement>('.cmux-screen')?.focus({ preventScroll: true });
    if (!value && !hadFocus) return;
    const nextInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.cmux-input');
    if (!nextInput) return;
    nextInput.value = value;
    if (hadFocus) {
      nextInput.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  private syncCmuxPolling(): void {
    if (!document.hidden && this.view === 'cmux' && this.cmuxConnected && isPolling(this.cmuxPanelState)) {
      this.restartCmuxScreenPoll();
    } else {
      this.stopCmuxScreenPoll();
    }
  }

  private restartCmuxScreenPoll(): void {
    this.stopCmuxScreenPoll();
    this.cmuxScreenTimer = setInterval(() => void this.pollCmuxScreen(), CMUX_SCREEN_POLL_MS);
  }

  private stopCmuxScreenPoll(): void {
    if (this.cmuxScreenTimer !== null) {
      clearInterval(this.cmuxScreenTimer);
      this.cmuxScreenTimer = null;
    }
  }

  private async pollCmuxScreen(): Promise<void> {
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface || this.view !== 'cmux' || document.hidden || this.cmuxScreenPending) return;
    this.cmuxScreenPending = true;
    try {
      const res: Response = await fetch(`/api/cmux/screen?surface=${encodeURIComponent(surface)}&lines=40`);
      if (this.view !== 'cmux' || this.cmuxPanelState.selectedSurface !== surface) return;
      if (res.status === 404) {
        if (this.cmuxScreen === CMUX_SCREEN_UNAVAILABLE) return;
        this.cmuxScreen = CMUX_SCREEN_UNAVAILABLE;
        this.setCmuxScreenText(this.cmuxScreen);
        return;
      }
      if (!res.ok) return;
      const data: CmuxScreenPayload = (await res.json()) as CmuxScreenPayload;
      if (this.view !== 'cmux' || this.cmuxPanelState.selectedSurface !== surface) return;
      this.cmuxScreen = data?.text ?? '';
      this.setCmuxScreenText(this.cmuxScreen);
    } catch {
      return;
    } finally {
      this.cmuxScreenPending = false;
    }
  }

  private setCmuxScreenText(text: string): void {
    const pre: HTMLElement | null = this.root.querySelector<HTMLElement>('.cmux-screen');
    if (pre) pre.textContent = text;
  }

  private async handleCmuxTabClick(btn: HTMLButtonElement): Promise<void> {
    const surface: string | undefined = btn.dataset.surface;
    if (!surface) return;
    this.cmuxPanelState = selectSurface(this.cmuxPanelState, surface);
    this.updateAddress({ ...this.route, view: 'cmux', surface: this.cmuxPanelState.selectedSurface, pane: 'screen' });
    this.cmuxScreen = '';
    this.paint();
    await this.pollCmuxScreen();
    this.syncCmuxPolling();
  }

  private showCmuxError(message: string): void {
    const detail: HTMLElement | null = this.root.querySelector<HTMLElement>('.cmux-detail');
    if (!detail) return;
    let errEl: HTMLDivElement | null = detail.querySelector<HTMLDivElement>('.cmux-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'cmux-error';
      errEl.setAttribute('role', 'alert');
      detail.appendChild(errEl);
    }
    errEl.textContent = message;
  }

  private clearCmuxError(): void {
    this.root.querySelector<HTMLElement>('.cmux-error')?.remove();
  }

  private async handleCmuxAction(btn: HTMLButtonElement): Promise<void> {
    const action: string | undefined = btn.dataset.action;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!action || !surface) return;
    const tab: CmuxTabView | undefined = this.cmuxTabs.find((t) => t.surfaceRef === surface);
    if (!tab) return;
    btn.disabled = true;
    try {
      const res: Response = await fetch('/api/cmux/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, provider: providerOf(tab), action }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Action failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Action failed.');
    } finally {
      btn.disabled = false;
    }
  }

  private async handleCmuxSend(form: HTMLFormElement): Promise<void> {
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    const input: HTMLInputElement | null = form.querySelector<HTMLInputElement>('.cmux-input');
    if (!surface || !input) return;
    const text: string = input.value;
    if (text.trim() === '') return;
    try {
      const res: Response = await fetch('/api/cmux/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, text, enter: true }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Send failed.');
        return;
      }
      this.clearCmuxError();
      input.value = '';
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Send failed.');
    }
  }

  private async handlePasteImage(event: ClipboardEvent): Promise<void> {
    if (this.view !== 'cmux') return;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface) return;
    const items: DataTransferItemList | undefined = event.clipboardData?.items;
    if (!items) return;
    const imageItem: DataTransferItem | undefined = Array.from(items).find((i) => i.type.startsWith('image/'));
    if (!imageItem) return;
    const file: File | null = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    const ext: string = file.type.split('/')[1] ?? 'png';
    let dataBase64: string;
    try {
      dataBase64 = await this.blobToBase64(file);
    } catch {
      this.showCmuxError('Could not read pasted image.');
      return;
    }
    try {
      const res: Response = await fetch('/api/cmux/paste-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, dataBase64, ext }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Image paste failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Image paste failed.');
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader: FileReader = new FileReader();
      reader.onerror = (): void => reject(new Error('read failed'));
      reader.onload = (): void => {
        const result: string = String(reader.result);
        const comma: number = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  private handleCmuxCaptureToggle(): void {
    this.cmuxCapturing = !this.cmuxCapturing;
    if (this.cmuxCapturing) this.startCapture();
    else this.stopCapture();
    this.repaintCmuxPreservingInput();
    this.root.querySelector<HTMLElement>(this.cmuxCapturing ? '.cmux-screen' : '[data-cmux-capture]')?.focus();
  }

  private startCapture(): void {
    document.addEventListener('keydown', this.onCaptureKeydown);
  }

  private stopCapture(): void {
    document.removeEventListener('keydown', this.onCaptureKeydown);
  }

  private handleCaptureKeydown(event: KeyboardEvent): void {
    if (this.view !== 'cmux' || !this.cmuxCapturing) return;
    if (event.key === 'Escape' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.handleCmuxCaptureToggle();
      return;
    }
    if (!(event.target instanceof HTMLElement) || !event.target.matches('.cmux-screen')) return;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface) return;
    const intent: CmuxKeyIntent = mapKeyEvent(event);
    if (intent.kind === 'ignore') return;
    event.preventDefault();
    if (intent.kind === 'key') void this.sendCmuxKey(surface, intent.token);
    else void this.sendCmuxText(surface, intent.text);
  }

  private async handleCmuxKeyPad(btn: HTMLButtonElement): Promise<void> {
    const key: string | undefined = btn.dataset.key;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!key || !surface) return;
    await this.sendCmuxKey(surface, key);
  }

  private async sendCmuxKey(surface: string, key: string): Promise<void> {
    try {
      const res: Response = await fetch('/api/cmux/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, key }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Key failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Key failed.');
    }
  }

  private async sendCmuxText(surface: string, text: string): Promise<void> {
    try {
      const res: Response = await fetch('/api/cmux/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, text, enter: false }),
      });
      if (!res.ok) {
        const errBody: { error?: string } = await res.json().catch(() => ({}) as { error?: string });
        this.showCmuxError(errBody?.error ?? 'Send failed.');
        return;
      }
      this.clearCmuxError();
      await this.pollCmuxScreen();
    } catch {
      this.showCmuxError('Send failed.');
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLFormElement && target.matches('[data-outcome-assessment]')) {
      event.preventDefault();
      void this.saveOutcomeAssessment(target);
      return;
    }
    if (target instanceof HTMLFormElement && target.matches('[data-todo-form]')) {
      event.preventDefault();
      void this.saveTodo(target);
      return;
    }
    if (!(target instanceof HTMLFormElement) || !target.classList.contains('cmux-send')) return;
    event.preventDefault();
    void this.withStableView(() => this.handleCmuxSend(target));
  }

  private async saveOutcomeAssessment(form: HTMLFormElement): Promise<void> {
    const runId = form.dataset.outcomeAssessment;
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId) || this.outcomesSavingRunId) return;
    const data = new FormData(form);
    const state = data.get('state');
    const outcome = data.get('outcome');
    if (!['complete', 'partial', 'failed', 'not-assessed'].includes(String(state)) || !['achieved', 'partial', 'not-achieved', 'unknown'].includes(String(outcome))) return;
    const correctionRaw = String(data.get('correctionRounds') ?? '').trim();
    const correctionRounds = correctionRaw === '' ? null : Number(correctionRaw);
    if (correctionRounds !== null && (!Number.isSafeInteger(correctionRounds) || correctionRounds < 0)) {
      const error = form.querySelector<HTMLElement>('.outcome-save-error');
      if (error) error.textContent = 'Correction rounds must be a whole non-negative number.';
      return;
    }
    this.outcomesSavingRunId = runId;
    this.outcomesEditing = false;
    this.paint();
    try {
      await saveOutcomeAssessment(runId, {
        state: state as 'complete' | 'partial' | 'failed' | 'not-assessed',
        outcome: outcome as 'achieved' | 'partial' | 'not-achieved' | 'unknown',
        summary: String(data.get('summary') ?? '').trim(),
        evidence: String(data.get('evidence') ?? '').split('\n').map(value => value.trim()).filter(Boolean),
        failureStage: String(data.get('failureStage') ?? '').trim() || null,
        correctionRounds,
      });
      this.outcomesSavingRunId = null;
      await this.loadOutcomes();
    } catch (error: unknown) {
      this.outcomesSavingRunId = null;
      this.outcomesError = error instanceof Error ? error.message : 'Could not save assessment.';
      this.outcomesEditing = true;
      this.paint();
    }
  }

  private paintRunRetries(): void {
    this.root.querySelectorAll<HTMLButtonElement>('button[data-retry-run-id]').forEach(button => {
      const state = this.runRetries.get(button.dataset.retryRunId ?? '');
      button.disabled = state?.pending ?? false;
      button.setAttribute('aria-busy', String(state?.pending ?? false));
      const label = button.querySelector('span');
      if (label) label.textContent = state?.pending ? 'Retrying…' : 'Retry';
      if (state?.pending || state?.error) button.dataset.retryState = state.pending ? 'pending' : 'error';
      else delete button.dataset.retryState;
    });
    this.root.querySelectorAll<HTMLElement>('[data-retry-feedback-for]').forEach(feedback => {
      const state = this.runRetries.get(feedback.dataset.retryFeedbackFor ?? '');
      feedback.textContent = state?.error ?? '';
      if (state?.error) feedback.dataset.retryState = 'error';
      else delete feedback.dataset.retryState;
    });
  }

  private async handleRetryRun(button: HTMLButtonElement): Promise<void> {
    const runId = button.dataset.retryRunId;
    if (!runId || !/^[a-z\d_-]{1,128}$/i.test(runId) || this.runRetries.get(runId)?.pending) return;
    this.runRetries.set(runId, { pending: true });
    this.paintRunRetries();
    try {
      const result = await retryRun(runId);
      if (this.destroyed) return;
      this.runRetries.delete(runId);
      const previous = this.runTabs.find(tab => tab.runId === runId);
      const run = this.runs.find(item => item.id === runId);
      const label = previous?.label ?? run?.ticketId ?? 'Retry';
      this.openRunTab(result.runId, label);
      this.focusRunTab(result.runId);
      void this.refresh();
    } catch (error: unknown) {
      if (this.destroyed) return;
      this.runRetries.set(runId, { pending: false, error: error instanceof Error ? error.message : term('retryFailed') });
    } finally {
      if (!this.destroyed) this.paintRunRetries();
    }
  }

  private async copyRunId(button: HTMLButtonElement): Promise<void> {
    const id = button.dataset.copyRunId;
    if (!id || !/^[a-z\d_-]{1,128}$/i.test(id) || this.copying.has(button)) return;
    this.copying.add(button);
    const copied = await copyText(id);
    this.copying.delete(button);
    if (this.destroyed || !button.isConnected) return;
    const previousTimer = this.copyTimers.get(button);
    if (previousTimer) clearTimeout(previousTimer);
    button.dataset.copyState = copied ? 'copied' : 'error';
    const feedback = button.querySelector<HTMLElement>('.voyage-copy-feedback');
    if (feedback) feedback.textContent = copied ? 'Copied' : 'Copy failed';
    this.copyTimers.set(button, setTimeout(() => {
      this.copyTimers.delete(button);
      delete button.dataset.copyState;
      if (feedback) feedback.textContent = '';
    }, 2_000));
  }

  private handleClick(event: MouseEvent): void {
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) return;
    const pirateToggle = target.closest<HTMLButtonElement>('[data-pirate-mode]');
    if (pirateToggle) {
      if (!pirateToggle.disabled) this.changePirateMode(!isPirateMode());
      return;
    }
    const copyButton = target.closest<HTMLButtonElement>('button[data-copy-run-id]');
    if (copyButton) {
      event.preventDefault();
      event.stopPropagation();
      if (!copyButton.disabled) void this.copyRunId(copyButton);
      return;
    }
    const retryButton = target.closest<HTMLButtonElement>('button[data-retry-run-id]');
    if (retryButton) {
      event.preventDefault();
      event.stopPropagation();
      if (!retryButton.disabled) void this.handleRetryRun(retryButton);
      return;
    }
    const slackReview = target.closest<HTMLButtonElement>('[data-slack-review-request]');
    if (slackReview) {
      event.preventDefault();
      if (!slackReview.disabled) void this.sendSlackReviewRequest(slackReview);
      return;
    }
    const todoButton = target.closest<HTMLButtonElement>('[data-todo-edit], [data-todo-delete], [data-todo-confirm-delete], [data-todo-cancel-delete], [data-todo-launch], [data-todo-cancel], [data-todo-new], [data-todo-refresh], [data-todo-auto-claim]');
    if (todoButton && this.view === 'todos') {
      if (!todoButton.disabled) void this.handleTodoAction(todoButton);
      return;
    }

    const historyButton = target.closest<HTMLButtonElement>('[data-runs-page], [data-runs-retry]');
    if (historyButton && this.view === 'runs') {
      if (historyButton.disabled || this.runHistory.loading) return;
      const direction = historyButton.dataset.runsPage;
      if (historyButton.hasAttribute('data-runs-retry')) void this.loadRunHistory();
      else if (direction === 'previous' && this.runHistory.offset > 0) void this.loadRunHistory(Math.max(0, this.runHistory.offset - RUN_HISTORY_PAGE_SIZE));
      else if (direction === 'next' && this.runHistory.offset + RUN_HISTORY_PAGE_SIZE < this.runHistory.total) void this.loadRunHistory(this.runHistory.offset + RUN_HISTORY_PAGE_SIZE);
      return;
    }

    const triagePage = target.closest<HTMLButtonElement>('button[data-triage-column][data-triage-page]');
    if (this.view === 'triage' && triagePage && !triagePage.disabled) {
      const column = triagePage.dataset.triageColumn;
      const page = Number(triagePage.dataset.triagePage);
      if ((column !== 'backlog' && column !== 'todo' && column !== 'mine') || !Number.isSafeInteger(page) || page < 1) return;
      const direction = page > this.triagePages[column] ? 'next' : 'previous';
      this.triagePages[column] = page;
      this.paintTriage();
      const pager = this.root.querySelector<HTMLElement>(`.triage-pagination[data-triage-column="${column}"]`);
      const buttons = pager?.querySelectorAll<HTMLButtonElement>('button');
      const button = direction === 'next' ? buttons?.[1] : buttons?.[0];
      (button && !button.disabled ? button : pager)?.focus({ preventScroll: true });
      return;
    }

    if (target.closest('[data-slack-toggle], [data-slack-close]')) {
      this.slackOpen = target.closest('[data-slack-close]') ? false : !this.slackOpen;
      this.paintSlack();
      this.root.querySelector<HTMLButtonElement>('[data-slack-toggle]')?.focus({ preventScroll: true });
      return;
    }
    const slackRead = target.closest<HTMLButtonElement>('[data-slack-read]');
    if (slackRead?.dataset.slackRead) {
      void this.readSlackNotification(slackRead.dataset.slackRead);
      return;
    }
    if (this.slackOpen && !target.closest('.slack-center')) {
      this.slackOpen = false;
      this.paintSlack();
    }

    const link = target.closest<HTMLAnchorElement>('a.view-toggle, a.app-link');
    if (link) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void this.navigate(parseRoute(new URL(link.href)));
      return;
    }

    const collapseBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.panel-collapse');
    if (collapseBtn) {
      this.rackLayout = toggleCollapse(this.rackLayout, collapseBtn.dataset.panel as PanelId);
      saveRackLayoutRaw(serializeRack(this.rackLayout));
      this.paint();
      this.root.querySelector<HTMLButtonElement>(`.panel-collapse[data-panel="${collapseBtn.dataset.panel}"]`)?.focus();
      return;
    }

    const surfaceCollapseBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.surface-collapse');
    if (surfaceCollapseBtn) {
      const id: string | undefined = surfaceCollapseBtn.dataset.collapseId;
      if (id) {
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        saveCollapsed(this.collapsed);
        if (id === 'runs:drawer') this.renderRunDrawer();
        else this.paint();
      }
      return;
    }

    const slotTab: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.slot-tab');
    if (slotTab) {
      this.rackLayout = setActivePanel(this.rackLayout, slotTab.dataset.panelTab as PanelId);
      this.updateAddress({ ...this.route, view: 'dashboard', pane: slotTab.dataset.panelTab ?? null });
      saveRackLayoutRaw(serializeRack(this.rackLayout));
      this.paint();
      this.root.querySelector<HTMLButtonElement>(`.slot-tab[data-panel-tab="${slotTab.dataset.panelTab}"]`)?.focus();
      return;
    }

    if (target.closest('[data-cmux-refresh]')) {
      void this.handleCmuxTabsChanged();
      return;
    }

    const cmuxTabBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-tab');
    if (cmuxTabBtn) {
      void this.handleCmuxTabClick(cmuxTabBtn);
      return;
    }

    const cmuxActionBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-action');
    if (cmuxActionBtn) {
      void this.withStableView(() => this.handleCmuxAction(cmuxActionBtn));
      return;
    }

    const cmuxCaptureToggle: HTMLButtonElement | null = target.closest<HTMLButtonElement>('[data-cmux-capture]');
    if (cmuxCaptureToggle) {
      this.handleCmuxCaptureToggle();
      return;
    }

    const cmuxKeypadBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-keypad-btn');
    if (cmuxKeypadBtn) {
      void this.handleCmuxKeyPad(cmuxKeypadBtn);
      return;
    }

    const assignButton = target.closest<HTMLButtonElement>('[data-assign-ticket]');
    if (assignButton && !assignButton.disabled) {
      void this.handleAssignTicket(assignButton);
      return;
    }

    const launchBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.launch-btn');
    if (launchBtn) {
      void this.withStableView(() => this.handleLaunchClick(launchBtn));
      return;
    }

    const stopBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.agent-stop');
    if (stopBtn) {
      void this.handleStopClick(stopBtn);
      return;
    }

    const newRunBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.newrun-launch');
    if (newRunBtn) {
      void this.withStableView(() => this.handleNewRun(newRunBtn));
      return;
    }

    const localGitButton = target.closest<HTMLButtonElement>('.local-git-panel button');
    if (localGitButton) {
      if (localGitButton.disabled) return;
      if (localGitButton.matches('.local-git-check-remotes')) void this.mutateLocalGit({ action: 'refresh-remotes' });
      else if (localGitButton.matches('.local-git-cleanup-preview')) void this.mutateLocalGit({
        action: 'preview-delete-untracked-branches', ...(this.localGit.cleanupForce ? { force: true } : {}),
      });
      else if (localGitButton.matches('.local-git-cleanup-cancel')) {
        this.localGit = { ...this.localGit, cleanup: undefined, cleanupForce: false };
        this.paintLocalGit();
      } else if (localGitButton.matches('.local-git-cleanup-confirm')) {
        const cleanup = this.localGit.cleanup;
        if (cleanup?.candidates.length) void this.mutateLocalGit({
          action: 'delete-untracked-branches', expectedHead: cleanup.expectedHead,
          branches: cleanup.candidates.map(({ branch, expectedCommit }) => ({ branch, expectedCommit })),
          ...(cleanup.force ? { force: true } : {}),
        });
      }
      else if (localGitButton.matches('.local-git-cancel')) {
        this.localGit = { ...this.localGit, confirmation: undefined };
        this.paintLocalGit();
      } else if (localGitButton.matches('.local-git-confirm-delete')) {
        const action = this.localGit.confirmation;
        if (action) void this.mutateLocalGit(action.action === 'delete-branch'
          ? { ...action, force: this.root.querySelector<HTMLInputElement>('.local-git-force')?.checked === true }
          : action);
      } else if (localGitButton.matches('.local-git-delete')) this.confirmLocalGitDeletion(localGitButton);
      else if (localGitButton.matches('.local-git-refresh')) void this.loadLocalGit();
      return;
    }

    if (target.closest('[data-config-retry]')) {
      if (!this.configLoading) void this.loadUiConfig();
      return;
    }
    const configSaveBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.config-save');
    if (configSaveBtn) {
      void this.handleConfigSave(configSaveBtn);
      return;
    }

    const lookupBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-lookup-go');
    if (lookupBtn) {
      void this.handlePrLookup();
      return;
    }

    const approveBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-approve');
    if (approveBtn) {
      void this.withStableView(() => this.handleReview(approveBtn, 'APPROVE'));
      return;
    }

    const requestChangesBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-request-changes');
    if (requestChangesBtn) {
      void this.withStableView(() => this.handleReview(requestChangesBtn, 'REQUEST_CHANGES'));
      return;
    }

    const commentBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-comment');
    if (commentBtn) {
      void this.withStableView(() => this.handleReview(commentBtn, 'COMMENT'));
      return;
    }

    const rerunBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-rerun');
    if (rerunBtn) {
      void this.withStableView(() => this.handleRerun(rerunBtn));
      return;
    }

    const reviewAgentBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-review-agent');
    if (reviewAgentBtn) {
      void this.withStableView(() => this.handleReviewAgent(reviewAgentBtn));
      return;
    }

    const reconnect = target.closest<HTMLButtonElement>('[data-reconnect-run-output]');
    if (reconnect) {
      const tab = this.runTabs.find(item => item.runId === reconnect.dataset.reconnectRunOutput);
      if (tab) this.connectRunStream(tab);
      return;
    }

    const tabCloseBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.run-tab-close');
    if (tabCloseBtn) {
      const id: string | undefined = tabCloseBtn.dataset.tabid;
      if (id) this.closeRunTab(id);
      return;
    }

    const tabSelectBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.run-tab-select');
    if (tabSelectBtn) {
      const id: string | undefined = tabSelectBtn.dataset.tabid;
      if (id) this.setActiveTab(id);
      return;
    }

    const prListRow: HTMLElement | null = target.closest<HTMLElement>('.pr-list-row');
    if (prListRow) {
      this.handlePrListClick(prListRow);
      return;
    }

    const openInTab: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-open-in-tab');
    if (openInTab) {
      const repo: string | undefined = openInTab.dataset.repo;
      const number: number = Number(openInTab.dataset.number);
      if (repo && Number.isFinite(number)) void this.enterPrView(repo, number);
      return;
    }

    if (target.closest('a')) return;
    const underwayRow = target.closest<HTMLElement>('.underway-row[data-underway-href]');
    if (underwayRow && !target.closest('button, input, select, textarea, label')) {
      this.openUnderwayRow(underwayRow);
      return;
    }
    const runRow: HTMLElement | null = target.closest<HTMLElement>('.agent-row, .recent-run');
    if (runRow) this.handleRunRowClick(runRow);
  }

  private prTarget(btn: HTMLElement): { panel: HTMLElement; repo: string; number: number } | null {
    const panel: HTMLElement | null = btn.closest<HTMLElement>('.pr-panel');
    const repo: string | undefined = panel?.dataset.prRepo;
    const numberRaw: string | undefined = panel?.dataset.prNumber;
    const number: number = Number(numberRaw);
    if (!panel || !repo || !numberRaw || !Number.isFinite(number)) return null;
    return { panel, repo, number };
  }

  private async handleReview(btn: HTMLElement, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<void> {
    const t: { panel: HTMLElement; repo: string; number: number } | null = this.prTarget(btn);
    if (!t) return;
    const prViewSeq = this.prViewSeq;
    const showOpenInTab = Boolean(t.panel.querySelector('.pr-open-in-tab'));
    const bodyEl: HTMLTextAreaElement | null = t.panel.querySelector<HTMLTextAreaElement>('.pr-review-body');
    const body: string = bodyEl?.value ?? '';
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && body.trim() === '') return;
    const result: { ok: boolean; error?: string } = await submitPrReview(t.repo, t.number, event, body);
    if (!result.ok) {
      const reviewEl: HTMLElement | null = t.panel.querySelector<HTMLElement>('.pr-review');
      const errEl: HTMLDivElement = document.createElement('div');
      errEl.className = 'pr-review-error';
      errEl.textContent = result.error ?? term('reviewFailed');
      reviewEl?.appendChild(errEl);
      return;
    }
    const refreshed: PrStatusView | null = await getPrStatus(t.repo, t.number);
    for (const tab of this.runTabs) {
      if (tab.pr?.repo !== t.repo || tab.pr.number !== t.number) continue;
      tab.prVersion = (tab.prVersion ?? 0) + 1;
      tab.prStatus = refreshed;
      tab.prLoadedAt = refreshed ? Date.now() : undefined;
    }
    if (refreshed && prViewSeq === this.prViewSeq && this.prView.repo === t.repo && this.prView.number === t.number) {
      this.prView = { ...this.prView, pr: refreshed };
    }
    if (t.panel.isConnected) {
      t.panel.outerHTML = renderPrPanel(refreshed, this.repos.includes(t.repo), showOpenInTab, this.selectedRepo);
      this.paintSlackReviewRequests();
    }
    void this.loadReviewRequests();
  }

  private async handleRerun(btn: HTMLElement): Promise<void> {
    const t: { panel: HTMLElement; repo: string; number: number } | null = this.prTarget(btn);
    if (!t) return;
    const feedbackEl: HTMLTextAreaElement | null = t.panel.querySelector<HTMLTextAreaElement>('.pr-rerun-feedback');
    const feedback: string = feedbackEl?.value ?? '';
    if (feedback.trim() === '') return;
    const seq: number = ++this.launchSeq;
    try {
      const result: LaunchResult = await launchRun({ mode: 'rerun', repo: t.repo, prNumber: t.number, feedback, ...this.readTuning(t.panel, 'pr') });
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, `feedback #${t.number}`);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : term('relaunchFailed');
      this.openErrorTab(`feedback #${t.number}`, message);
    }
  }

  private async handleReviewAgent(btn: HTMLElement): Promise<void> {
    const t: { panel: HTMLElement; repo: string; number: number } | null = this.prTarget(btn);
    if (!t) return;
    const seq: number = ++this.launchSeq;
    try {
      const result: LaunchResult = await launchRun({ mode: 'review', repo: t.repo, prNumber: t.number, ...this.readTuning(t.panel, 'pr') });
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, `${term('review')} #${t.number}`);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : term('reviewFailed');
      this.openErrorTab(`${term('review')} #${t.number}`, message);
    }
  }

  private async handlePrLookup(): Promise<void> {
    const input: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.pr-lookup-input');
    if (!input) return;
    const parsed: { repo: string; number: number } | null = parsePrUrl(input.value);
    const result: HTMLElement | null = this.root.querySelector<HTMLElement>('.pr-lookup-result');
    if (!parsed) {
      if (result) result.innerHTML = `<div class="pr-panel empty-note">${term('prLookupInvalid')}</div>`;
      return;
    }
    await this.loadPrView(parsed.repo, parsed.number);
  }

  private async loadPrView(repo: string, number: number, updateRoute: boolean = true): Promise<void> {
    if (updateRoute) this.updateAddress({ ...this.route, view: this.view, repo: this.selectedRepo, prRepo: repo, pr: number, pane: this.view === 'runs' ? 'newrun' : 'lookup' });
    const seq: number = ++this.prViewSeq;
    this.prView = { repo, number, pr: null, diff: null, loading: true };
    if (this.view === 'prs' || this.view === 'runs') this.paint();
    const [pr, diff] = await Promise.all([getPrStatus(repo, number), getPrDiff(repo, number)]);
    if (seq !== this.prViewSeq) return;
    this.prView = { repo, number, pr, diff, loading: false };
    if (this.view === 'prs' || this.view === 'runs') this.paint();
  }

  private async enterPrView(repo?: string, number?: number): Promise<void> {
    await this.navigate(parseRoute(new URL(routeHref({ view: 'prs', repo: this.selectedRepo, prRepo: repo ?? null, pr: number ?? null, pane: number ? 'lookup' : null }), window.location.origin)));
  }

  private handlePrListClick(row: HTMLElement): void {
    const repo: string | undefined = row.dataset.repo;
    const number: number = Number(row.dataset.number);
    if (!repo || !Number.isSafeInteger(number) || number <= 0) return;
    void this.enterPrView(repo, number).then(() => {
      if (this.view !== 'prs' || this.prView.repo !== repo || this.prView.number !== number) return;
      this.root.querySelector<HTMLElement>('.pr-lookup-panel')?.scrollIntoView?.({ block: 'start' });
      this.root.querySelector<HTMLInputElement>('.pr-lookup-input')?.focus({ preventScroll: true });
    });
  }

  private openUnderwayRow(row: HTMLElement): void {
    const href = row.dataset.underwayHref;
    if (href) void this.navigate(parseRoute(new URL(href, window.location.origin)));
  }

  private async handleStopClick(btn: HTMLButtonElement): Promise<void> {
    const runId: string | undefined = btn.dataset.runid;
    if (!runId) return;
    await stopAgent(runId);
    await this.refresh();
  }

  private handleRunRowClick(row: HTMLElement): void {
    const runId: string | undefined = row.dataset.runid;
    if (!runId) return;
    void this.navigate({ ...this.route, view: 'runs', pane: 'tasks', run: runId });
  }

  private openRunTab(runId: string, label: string, updateRoute: boolean = true): void {
    if (updateRoute) this.updateAddress({ ...this.route, view: this.view, run: runId });
    const existing: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === runId);
    if (existing) {
      this.setActiveTab(runId, false);
      return;
    }
    const run: RunSummary | undefined = this.runs.find((r: RunSummary): boolean => r.id === runId);
    const tab: RunTab = {
      runId,
      label,
      lines: [],
      footer: run ?? null,
      pr: run && run.prNumber != null ? { repo: run.repo, number: run.prNumber } : null,
      unsub: null,
      complete: this.isTerminalRunStatus(run?.status),
      status: run?.status,
    };
    this.runTabs.push(tab);
    this.connectRunStream(tab);
    this.activeTabId = runId;
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private connectRunStream(tab: RunTab): void {
    tab.unsub?.();
    tab.unsub = openRunStream(tab.runId, event => this.onTabEvent(tab.runId, event), state => {
      if (this.destroyed || !this.runTabs.includes(tab)) return;
      tab.streamState = state;
      if (tab.runId === this.activeTabId) this.paintRunStreamStatus();
    });
  }

  private paintRunStreamStatus(): void {
    const slot = this.runDrawerEl.querySelector<HTMLElement>('.run-stream-status');
    const tab = this.runTabs.find(item => item.runId === this.activeTabId);
    if (!slot || !tab) return;
    const state = tab.streamState ?? 'connecting';
    const hidden = tab.runId.startsWith('err-') || state === 'live' && tab.lines.length > 0;
    if (slot.hidden === hidden && slot.dataset.state === state && slot.dataset.runId === tab.runId) return;
    slot.hidden = hidden;
    slot.dataset.state = state;
    slot.dataset.runId = tab.runId;
    slot.replaceChildren();
    if (hidden) return;
    slot.textContent = state === 'connecting' ? 'Connecting to output…'
      : state === 'reconnecting' ? 'Output connection interrupted. Reconnecting…'
      : state === 'unavailable' ? 'Output is unavailable. The run may still be preparing or running. '
      : 'Connected. Waiting for output…';
    if (state === 'unavailable') {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.reconnectRunOutput = tab.runId;
      button.textContent = 'Reconnect output';
      slot.append(button);
    }
  }

  private openErrorTab(label: string, message: string): void {
    const id: string = `err-${++this.tabSeq}`;
    const tab: RunTab = {
      runId: id,
      label,
      lines: [{ id: 0, runId: '', ts: new Date().toISOString(), kind: 'error', text: message }],
      footer: null,
      pr: null,
      unsub: null,
      complete: true,
      status: 'failed',
    };
    this.runTabs.push(tab);
    this.activeTabId = id;
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private setActiveTab(runId: string, updateRoute: boolean = true): void {
    if (!this.runTabs.some((t: RunTab): boolean => t.runId === runId)) return;
    this.activeTabId = runId;
    if (updateRoute) this.updateAddress({ ...this.route, view: this.view, run: runId });
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private closeRunTab(runId: string): void {
    const idx: number = this.runTabs.findIndex((t: RunTab): boolean => t.runId === runId);
    if (idx < 0) return;
    const focusedTab = document.activeElement?.closest<HTMLElement>('.run-tab')?.dataset.tabid;
    this.runTabs[idx]?.unsub?.();
    this.runTabs.splice(idx, 1);
    if (this.activeTabId === runId) {
      const next: RunTab | undefined = this.runTabs[idx] ?? this.runTabs[idx - 1];
      this.activeTabId = next ? next.runId : null;
    }
    this.updateAddress({ ...this.route, view: this.view, run: this.activeTabId?.startsWith('err-') ? null : this.activeTabId });
    this.renderRunDrawer();
    this.rehomeRunDrawer();
    if (focusedTab === runId) {
      if (this.activeTabId) this.focusRunTab(this.activeTabId);
      else this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body')?.focus();
    }
  }

  private focusRunTab(runId: string): void {
    const button = this.runDrawerEl.querySelector<HTMLButtonElement>(`.run-tab-select[data-tabid="${CSS.escape(runId)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private isTerminalRunStatus(status?: string): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'stopped';
  }

  private onTabEvent(runId: string, event: RunEvent): void {
    if (this.destroyed) return;
    const tab = this.runTabs.find(item => item.runId === runId);
    if (!tab) return;
    if (event.id > 0) {
      if (event.id <= (tab.lastEventId ?? 0)) return;
      tab.lastEventId = event.id;
    }
    tab.lines.push(event);
    if (tab.lines.length > RUN_LOG_PREVIEW_LIMIT) tab.lines.splice(0, tab.lines.length - RUN_LOG_PREVIEW_LIMIT);
    if (event.kind === 'run-complete') {
      tab.complete = true;
      tab.status = this.isTerminalRunStatus(event.text) ? event.text : 'completed';
      tab.unsub?.();
      tab.unsub = null;
      this.updateRunTabStatus(tab);
      void this.finalizeTab(runId);
    }
    if (runId === this.activeTabId) {
      this.paintRunStreamStatus();
      this.scheduleRunLogFlush();
    }
  }

  private updateRunTabStatus(tab: RunTab): void {
    const element = this.runDrawerEl.querySelector<HTMLElement>(`.run-tab[data-tabid="${CSS.escape(tab.runId)}"]`);
    if (!element) return;
    const status = runTabStatus(tab.status, tab.complete);
    element.dataset.runStatus = status.kind;
    const badge = element.querySelector<HTMLElement>('.run-tab-status');
    if (badge) badge.textContent = status.label;
    if (tab.runId === this.activeTabId) {
      const retrySlot = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-retry');
      if (retrySlot) retrySlot.innerHTML = tab.status === 'failed' ? renderVoyageRetry(tab.runId) : '';
      this.paintRunRetries();
    }
  }

  private async finalizeTab(runId: string): Promise<void> {
    const summary: RunStatusSummary | null = await getRun(runId);
    const tab: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === runId);
    if (!tab || this.destroyed) return;
    tab.footer = summary;
    if (summary) {
      tab.status = summary.status;
      this.updateRunTabStatus(tab);
    }
    if (summary && summary.prNumber != null && !tab.pr) {
      tab.pr = { repo: summary.repo, number: summary.prNumber };
    }
    if (runId === this.activeTabId) {
      this.renderFooterDom(tab);
      if (tab.pr) void this.loadTabPr(runId, tab.pr.repo, tab.pr.number, true);
    }
  }

  private async loadTabPr(runId: string, repo: string, prNumber: number, refresh = false): Promise<void> {
    const tab = this.runTabs.find(item => item.runId === runId);
    if (!tab || this.destroyed) return;
    if (refresh && tab.prPending) await tab.prPending;
    if (this.destroyed || !this.runTabs.includes(tab)) return;
    if (refresh) tab.prLoadedAt = undefined;
    if ((tab.prLoadedAt === undefined || Date.now() - tab.prLoadedAt >= POLL_MS) && !tab.prPending) {
      const version = tab.prVersion ?? 0;
      tab.prPending = getPrStatus(repo, prNumber).then(pr => {
        if (version !== (tab.prVersion ?? 0)) return;
        tab.prStatus = pr;
        tab.prLoadedAt = pr ? Date.now() : undefined;
      }).finally(() => { tab.prPending = undefined; });
    }
    await tab.prPending;
    if (this.destroyed || !this.runTabs.includes(tab) || runId !== this.activeTabId) return;
    const prEl = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-pr');
    if (prEl) {
      prEl.innerHTML = renderPrPanel(tab.prStatus ?? null, this.repos.includes(repo), true, this.selectedRepo);
      this.paintSlackReviewRequests();
    }
  }

  private rehomeRunDrawer(): void {
    const slot = this.root.querySelector<HTMLElement>('.runs-drawer-slot');
    if (slot && this.runDrawerEl.parentElement !== slot) slot.appendChild(this.runDrawerEl);
    if (this.canRenderRunLog()) this.scheduleRunLogFlush();
    else this.cancelRunLogFlush();
  }

  private renderRunDrawer(refreshPr: boolean = true): void {
    this.cancelRunLogFlush();
    this.renderedRunLines = [];
    const tabsView: RunTabView[] = this.runTabs.map((t: RunTab): RunTabView => ({
      id: t.runId,
      label: t.label,
      complete: t.complete,
      status: t.status,
    }));
    const drawerCollapsed: boolean = this.collapsed.has('runs:drawer') && this.runTabs.length > 0;
    this.runDrawerEl.innerHTML = renderRunsDrawer(tabsView, this.activeTabId, drawerCollapsed);
    this.runDrawerEl.classList.toggle('is-collapsed', drawerCollapsed);
    this.paintRunRetries();
    const active: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === this.activeTabId);
    if (!active) return;
    this.paintRunStreamStatus();
    const body: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    if (body) {
      body.addEventListener('scroll', () => this.updateStick(body));
      this.stickToBottom = true;
      this.scheduleRunLogFlush();
    }
    this.renderFooterDom(active);
    if (active.pr) {
      if (refreshPr) void this.loadTabPr(active.runId, active.pr.repo, active.pr.number);
      else {
        const panel = this.runDrawerEl.querySelector('.run-drawer-pr');
        if (panel) panel.innerHTML = renderPrPanel(active.prStatus ?? null, this.repos.includes(active.pr.repo), true, this.selectedRepo);
        this.paintSlackReviewRequests();
      }
    }
  }

  private lineEl(event: RunEvent): HTMLDivElement {
    const line: HTMLDivElement = document.createElement('div');
    line.className = `run-line run-line-${event.kind}`;
    appendHighlightedLog(line, event.text, event.kind);
    return line;
  }

  private canRenderRunLog(): boolean {
    return !this.destroyed && !document.hidden && this.runDrawerEl.isConnected
      && !this.collapsed.has('runs:drawer');
  }

  private cancelRunLogFlush(): void {
    if (this.runLogTimer !== null) clearTimeout(this.runLogTimer);
    this.runLogTimer = null;
  }

  private scheduleRunLogFlush(): void {
    if (this.runLogTimer !== null || !this.canRenderRunLog()) return;
    this.runLogTimer = setTimeout(() => {
      this.runLogTimer = null;
      this.flushRunLog();
    }, RUN_LOG_BATCH_MS);
  }

  private flushRunLog(): void {
    if (!this.canRenderRunLog()) return;
    const tab = this.runTabs.find(item => item.runId === this.activeTabId);
    const body = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    if (!tab || !body) return;
    const retained = this.renderedRunLines.filter(line => tab.lines.includes(line));
    const removed = this.renderedRunLines.length - retained.length;
    const previousHeight = !this.stickToBottom && removed > 0 ? body.scrollHeight : 0;
    const previousTop = body.scrollTop;
    for (let index = 0; index < removed; index++) body.firstElementChild?.remove();
    const removedHeight = previousHeight ? previousHeight - body.scrollHeight : 0;
    const fragment = document.createDocumentFragment();
    for (let index = retained.length; index < tab.lines.length; index++) {
      fragment.appendChild(this.lineEl(tab.lines[index]!));
    }
    body.appendChild(fragment);
    this.renderedRunLines = [...tab.lines];
    if (this.stickToBottom) body.scrollTop = body.scrollHeight;
    else if (removed > 0) body.scrollTop = Math.max(0, previousTop - removedHeight);
  }

  private updateStick(body: HTMLElement): void {
    this.stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  private renderFooterDom(tab: RunTab): void {
    const footer: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-footer');
    if (!footer) return;
    footer.textContent = '';
    const summary: RunStatusSummary | null = tab.footer;
    if (!summary) return;

    const statusLine: HTMLDivElement = document.createElement('div');
    statusLine.className = 'run-drawer-footer-status';
    statusLine.textContent = `${term('ticketStatus')}: ${deriveTicketStatus(summary)}`;
    footer.appendChild(statusLine);

    if (summary.prNumber == null) return;
    const prLine: HTMLDivElement = document.createElement('div');
    prLine.className = 'run-drawer-footer-pr';
    const repoParts: string[] = summary.repo.split('/');
    if (repoParts.length === 2 && repoParts[0] && repoParts[1]) {
      const link: HTMLAnchorElement = document.createElement('a');
      link.href = `https://github.com/${summary.repo}/pull/${summary.prNumber}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${term('pr')} #${summary.prNumber}`;
      prLine.appendChild(link);
    } else {
      prLine.textContent = `${term('pr')} #${summary.prNumber}`;
    }
    footer.appendChild(prLine);
  }

  private async handleAssignTicket(button: HTMLButtonElement): Promise<void> {
    const ticketId = button.dataset.assignTicket;
    if (!ticketId) return;
    const status = button.closest('.triage-row')?.querySelector<HTMLElement>('.ticket-action-status');
    button.disabled = true;
    if (status) status.textContent = 'Assigning…';
    try {
      await assignTicketToMe(ticketId);
      if (status) status.textContent = 'Assigned to you.';
      button.textContent = 'Assigned to me';
      if (this.view === 'triage') {
        await this.loadTriage();
        if (this.view === 'triage') this.paintTriage();
      }
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : 'Unable to assign ticket.';
      button.disabled = false;
    }
  }

  private async handleLaunchClick(btn: HTMLButtonElement): Promise<void> {
    const ticketId: string | undefined = btn.dataset.ticket;
    const title: string | undefined = btn.dataset.title;
    const repo: string | undefined = btn.dataset.repo;
    if (!ticketId || !repo) return;
    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = this.jiraEnabled
        ? await launchAgent(ticketId, title ?? ticketId, repo)
        : await launchRun({ mode: 'todo', todoId: ticketId, repo });
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, ticketId);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : term('launchFailed');
      this.openErrorTab(ticketId, message);
    } finally {
      btn.disabled = false;
    }
  }

  private readTuning(scope: ParentNode, prefix: string): { model?: string; effort?: string } {
    const model: string = scope.querySelector<HTMLSelectElement>(`.${prefix}-model`)?.value ?? '';
    const effort: string = scope.querySelector<HTMLSelectElement>(`.${prefix}-effort`)?.value ?? '';
    const tuning: { model?: string; effort?: string } = {};
    if (model) tuning.model = model;
    if (effort) tuning.effort = effort;
    return tuning;
  }

  private buildNewRunPayload(mode: 'ticket' | 'freeform'): { body: LaunchRunBody; ticketId: string; title: string } | null {
    const repoSelect: HTMLSelectElement | null = this.root.querySelector<HTMLSelectElement>('.newrun-repo');
    const repo: string = repoSelect?.value ?? '';
    if (!repo) return null;
    const tuning: { model?: string; effort?: string } = this.readTuning(this.root, 'newrun');

    if (mode === 'freeform') {
      const taskEl: HTMLTextAreaElement | null = this.root.querySelector<HTMLTextAreaElement>('.newrun-task');
      const task: string = taskEl?.value ?? '';
      if (task.trim() === '') return null;
      return { body: { repo, task, mode: 'freeform', ...tuning }, ticketId: 'freeform', title: task };
    }

    const ticketEl: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-ticket');
    const titleEl: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-title');
    const ticketId: string = ticketEl?.value ?? '';
    if (ticketId.trim() === '') return null;
    const title: string = titleEl?.value || ticketId;
    return { body: { ticketId, title, repo, mode: 'ticket', ...tuning }, ticketId, title };
  }

  private async handleNewRun(btn: HTMLButtonElement): Promise<void> {
    if (this.newRunPending) return;
    const modeInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-mode:checked');
    const mode: 'ticket' | 'freeform' = modeInput?.value === 'freeform' ? 'freeform' : 'ticket';
    const payload: { body: LaunchRunBody; ticketId: string; title: string } | null =
      this.buildNewRunPayload(mode);
    if (!payload) return;
    const { body, ticketId, title } = payload;

    this.newRunPending = true;
    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = await launchRun(body);
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, ticketId || title);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : term('launchFailed');
      this.openErrorTab(ticketId || title, message);
    } finally {
      this.newRunPending = false;
      btn.disabled = false;
      if (!this.destroyed) {
        const current = this.root.querySelector<HTMLButtonElement>('.newrun-launch');
        if (current) current.disabled = false;
      }
    }
  }

  private async handleConfigSave(btn: HTMLButtonElement): Promise<void> {
    if (btn.disabled || !this.configLoaded) return;
    const row = btn.closest<HTMLElement>('.config-row');
    const key = row?.dataset.key;
    const input = row?.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
    if (!key || !input || this.configPendingKeys.has(key)) return;
    if (!input.reportValidity()) return;
    this.captureConfigDrafts();
    const value = input.value;
    this.configErrors.delete(key);
    input.removeAttribute('aria-invalid');
    const errorEl = row?.querySelector<HTMLElement>('.config-error');
    if (errorEl) errorEl.textContent = '';
    btn.disabled = true;
    this.configPendingKeys.add(key);
    ++this.configSeq;
    this.configLoading = false;
    ++this.configSaves;
    this.syncPirateToggle();
    try {
      const result = await setConfig(key, value);
      if (this.destroyed) return;
      if (!result.ok) {
        const error = result.error || 'Save failed. Check the Helmsman connection and try again.';
        this.configErrors.set(key, error);
        for (const currentRow of this.root.querySelectorAll<HTMLElement>('.config-row')) {
          if (currentRow.dataset.key !== key) continue;
          const currentError = currentRow.querySelector('.config-error');
          if (currentError) currentError.textContent = error;
          currentRow.querySelector('.config-input')?.setAttribute('aria-invalid', 'true');
        }
        return;
      }
      ++this.configSeq;
      ++this.refreshSeq;
      this.refreshPending = null;
      this.captureConfigDrafts();
      if (this.configDrafts.get(key) === value) this.configDrafts.delete(key);
      if (key === 'JIRA_API_TOKEN') this.uiConfig.jiraTokenSet = true;
      else this.uiConfig.config[key] = value;
      for (const currentRow of this.root.querySelectorAll<HTMLElement>('.config-row')) {
        if (currentRow.dataset.key !== key) continue;
        const currentInput = currentRow.querySelector<HTMLInputElement | HTMLSelectElement>('.config-input');
        if (!currentInput) continue;
        currentInput.dataset.configValue = key === 'JIRA_API_TOKEN' ? '' : value;
        if (key === 'JIRA_API_TOKEN' && currentInput.value === value) currentInput.value = '';
      }
      if (key === 'JIRA_ENABLED') {
        this.jiraEnabled = value !== 'false';
        this.jiraBaseUrl = null;
        this.snapshot = null;
        this.dashboardRepo = undefined;
        this.lastDashboardRefresh = -Infinity;
        ++this.todosSeq;
        const context = await getContext();
        if (this.destroyed) return;
        if (context) {
          this.repos = context.repos;
          this.jiraBaseUrl = context.jiraBaseUrl;
        }
        this.syncShell();
      }
      this.configPendingKeys.delete(key);
      if (this.configPendingKeys.size === 0) await this.refresh();
    } finally {
      this.configPendingKeys.delete(key);
      btn.disabled = false;
      for (const button of this.root.querySelectorAll<HTMLButtonElement>('.config-save')) {
        if (button.dataset.key === key) button.disabled = false;
      }
      --this.configSaves;
      this.syncPirateToggle();
    }
  }

}

function armBootScreen(boot: HTMLElement): () => void {
  applyBootTerminology(boot);
  const MIN_MS: number = 2000;
  const CAP_MS: number = 4200;
  const start: number = performance.now();
  const pctEl: HTMLElement | null = boot.querySelector<HTMLElement>('.boot-pct');
  let dismissed: boolean = false;
  let raf: number = 0;

  const tick = (): void => {
    if (dismissed) return;
    const t: number = Math.min(1, (performance.now() - start) / MIN_MS);
    if (pctEl) pctEl.textContent = String(Math.min(99, Math.round(t * 100)));
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    cancelAnimationFrame(raf);
    if (pctEl) pctEl.textContent = '100';
    boot.removeEventListener('click', skip);
    window.removeEventListener('keydown', skip);
    boot.classList.add('boot-out');
    window.setTimeout(() => boot.remove(), 520);
  };
  function skip(): void {
    if (performance.now() - start >= MIN_MS) dismiss();
  }
  boot.addEventListener('click', skip);
  window.addEventListener('keydown', skip);
  window.setTimeout(dismiss, CAP_MS);

  return (): void => {
    const elapsed: number = performance.now() - start;
    window.setTimeout(dismiss, Math.max(0, MIN_MS - elapsed));
  };
}

export function bootstrap(): void {
  const root: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('missing #app root element');
  const view: DashboardView = new DashboardView(root);
  const boot: HTMLElement | null = document.getElementById('boot');
  const finishBoot: () => void = boot ? armBootScreen(boot) : (): void => {};
  void view.start().then(finishBoot, finishBoot);
}

if (import.meta.env.MODE !== 'test') bootstrap();
