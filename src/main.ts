import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard, renderPrPanel, renderCmuxView, renderRunsDrawer } from './render';
import type { RunTabView } from './render';
import type { DashboardSnapshot } from './data/mock';
import {
  launchAgent,
  launchRun,
  openRunStream,
  getRun,
  fetchAgents,
  setAutoClaim,
  stopAgent,
  type AgentCaps,
  type LaunchResult,
  type LaunchRunBody,
  type RunEvent,
  type RunStatusSummary,
  type RunSummary,
} from './data/agents';
import { getConfig, setConfig, type UiConfig } from './data/config';
import { getPrStatus, submitReview as submitPrReview, parsePrUrl, type PrStatusView } from './data/pr';
import { selectSurface, isPolling, providerOf, type CmuxTabView, type PanelState } from './logic/cmuxPanel';
import { mapKeyEvent, type CmuxKeyIntent } from './logic/cmuxKeys';
import { applyTheme, loadThemeId, saveThemeId } from './data/themes';
import {
  loadRepoScope,
  saveRepoScope,
  loadConfigCollapsed,
  saveConfigCollapsed,
} from './logic/prefs';

const CMUX_SCREEN_POLL_MS: number = 750;
const CMUX_SCREEN_UNAVAILABLE: string = 'Screen unavailable — tab has no rendered output yet.';

interface CmuxTabsPayload {
  connected?: boolean;
  tabs?: CmuxTabView[];
}

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
  footer: RunStatusSummary | null;
  pr: { repo: string; number: number } | null;
  unsub: (() => void) | null;
  complete: boolean;
}

function deriveTicketStatus(summary: RunStatusSummary): string {
  if (summary.status === 'succeeded' && summary.prNumber != null) return 'In Review';
  if (summary.status === 'succeeded') return 'Succeeded';
  if (summary.status === 'failed') return 'Failed';
  if (summary.status === 'stopped') return 'Stopped';
  return summary.status;
}

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly runDrawerEl: HTMLElement;
  private runTabs: RunTab[] = [];
  private activeTabId: string | null = null;
  private tabSeq: number = 0;
  private snapshot: DashboardSnapshot | null = null;
  private degraded: string[] = [];
  private repos: string[] = [];
  private selectedRepo: string | null = loadRepoScope();
  private runs: RunSummary[] = [];
  private autoClaimRepos: string[] = [];
  private caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null };
  private uiConfig: UiConfig = { config: {}, overridden: [] };
  private configCollapsed: boolean = loadConfigCollapsed();
  private launchSeq: number = 0;
  private view: 'dashboard' | 'cmux' = 'dashboard';
  private cmuxConnected: boolean = false;
  private cmuxTabs: CmuxTabView[] = [];
  private cmuxPanelState: PanelState = { selectedSurface: null };
  private cmuxScreen: string = '';
  private cmuxScreenTimer: ReturnType<typeof setInterval> | null = null;
  private cmuxEventSource: EventSource | null = null;
  private cmuxCapturing: boolean = false;
  private readonly onCaptureKeydown = (event: KeyboardEvent): void => this.handleCaptureKeydown(event);
  private themeId: string = loadThemeId();

  constructor(root: HTMLElement) {
    this.root = root;
    applyTheme(this.themeId);
    this.root.addEventListener('click', (event: MouseEvent): void => this.handleClick(event));
    this.root.addEventListener('submit', (event: SubmitEvent): void => this.handleSubmit(event));

    const drawer: HTMLDivElement = document.createElement('div');
    drawer.className = 'run-drawer';
    drawer.hidden = true;
    drawer.addEventListener('click', (event: MouseEvent): void => this.handleClick(event));
    this.runDrawerEl = drawer;
  }

  async refresh(): Promise<void> {
    const response: DashboardResponse | null = await loadDashboard(this.selectedRepo).catch(() => null);
    if (response) {
      this.snapshot = response.snapshot;
      this.degraded = response.degraded;
      this.repos = response.repos;
      this.selectedRepo = response.selectedRepo;
    }
    const agents: { runs: RunSummary[]; autoClaim: string[]; caps: AgentCaps } = await fetchAgents();
    this.runs = agents.runs;
    this.autoClaimRepos = agents.autoClaim;
    this.caps = agents.caps;
    this.uiConfig = await getConfig();
    if (this.view === 'dashboard') this.paint();
  }

  private paint(): void {
    if (this.view === 'cmux') {
      this.paintCmux();
      return;
    }
    if (!this.snapshot) return;
    renderDashboard(
      this.root,
      this.snapshot,
      new Date(),
      this.degraded,
      this.repos,
      this.selectedRepo,
      this.runs,
      this.autoClaimRepos,
      this.caps,
      this.uiConfig,
      this.themeId,
      this.configCollapsed,
    );
    const select: HTMLSelectElement | null =
      this.root.querySelector<HTMLSelectElement>('.repo-select');
    if (select) {
      select.addEventListener('change', () => {
        this.selectedRepo = select.value || null;
        saveRepoScope(this.selectedRepo);
        void this.refresh();
      });
    }
    const autoClaimCheckbox: HTMLInputElement | null =
      this.root.querySelector<HTMLInputElement>('.auto-claim-toggle');
    if (autoClaimCheckbox) {
      autoClaimCheckbox.addEventListener('change', () => void this.handleAutoClaimChange(autoClaimCheckbox));
    }
    const themeSelect: HTMLSelectElement | null =
      this.root.querySelector<HTMLSelectElement>('.theme-select');
    if (themeSelect) {
      themeSelect.addEventListener('change', () => {
        this.themeId = themeSelect.value;
        applyTheme(this.themeId);
        saveThemeId(this.themeId);
      });
    }
    this.rehomeRunDrawer();
  }

  private paintCmux(): void {
    this.root.innerHTML = renderCmuxView({
      connected: this.cmuxConnected,
      tabs: this.cmuxTabs,
      selectedSurface: this.cmuxPanelState.selectedSurface,
      screen: this.cmuxScreen,
      isCapturing: this.cmuxCapturing,
    });
  }

  private async enterCmuxView(): Promise<void> {
    this.view = 'cmux';
    await this.loadCmuxTabs();
    this.ensureCmuxEvents();
    this.paint();
    if (isPolling(this.cmuxPanelState)) {
      await this.pollCmuxScreen();
      this.syncCmuxPolling();
    }
  }

  private leaveCmuxView(): void {
    this.stopCmuxScreenPoll();
    this.stopCapture();
    this.cmuxCapturing = false;
    this.view = 'dashboard';
    this.paint();
  }

  private async loadCmuxTabs(): Promise<void> {
    try {
      const res: Response = await fetch('/api/cmux/tabs');
      const data: CmuxTabsPayload = res.ok ? ((await res.json()) as CmuxTabsPayload) : {};
      this.cmuxConnected = data?.connected ?? false;
      this.cmuxTabs = data?.tabs ?? [];
    } catch {
      this.cmuxConnected = false;
      this.cmuxTabs = [];
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
      if (msg.kind === 'cmux-tabs-changed') void this.handleCmuxTabsChanged();
    };
    this.cmuxEventSource = src;
  }

  private cmuxSnapshotSignature(): string {
    const tabsPart: string = this.cmuxTabs
      .map((t) => `${t.surfaceRef}${t.surfaceTitle}${t.workspaceTitle}${t.type}`)
      .join('');
    return `${this.cmuxConnected}${tabsPart}`;
  }

  private async handleCmuxTabsChanged(): Promise<void> {
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
    const value: string = prevInput?.value ?? '';
    const selectionStart: number | null = prevInput?.selectionStart ?? null;
    const selectionEnd: number | null = prevInput?.selectionEnd ?? null;

    this.paint();

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
    if (this.view === 'cmux' && this.cmuxConnected && isPolling(this.cmuxPanelState)) {
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
    if (!surface || this.view !== 'cmux') return;
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

  private handleCmuxCaptureToggle(): void {
    this.cmuxCapturing = !this.cmuxCapturing;
    if (this.cmuxCapturing) this.startCapture();
    else this.stopCapture();
    this.paint();
    if (this.cmuxCapturing) {
      this.root.querySelector<HTMLElement>('.cmux-screen')?.focus();
    }
  }

  private startCapture(): void {
    document.addEventListener('keydown', this.onCaptureKeydown);
  }

  private stopCapture(): void {
    document.removeEventListener('keydown', this.onCaptureKeydown);
  }

  private handleCaptureKeydown(event: KeyboardEvent): void {
    if (this.view !== 'cmux' || !this.cmuxCapturing) return;
    if (this.isEditableTarget(event.target)) return;
    const surface: string | null = this.cmuxPanelState.selectedSurface;
    if (!surface) return;
    const intent: CmuxKeyIntent = mapKeyEvent(event);
    if (intent.kind === 'ignore') return;
    event.preventDefault();
    if (intent.kind === 'key') void this.sendCmuxKey(surface, intent.token);
    else void this.sendCmuxText(surface, intent.text);
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
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
    if (!(target instanceof HTMLFormElement) || !target.classList.contains('cmux-send')) return;
    event.preventDefault();
    void this.handleCmuxSend(target);
  }

  private async handleAutoClaimChange(checkbox: HTMLInputElement): Promise<void> {
    const repo: string | null = this.selectedRepo;
    if (!repo) return;
    await setAutoClaim(repo, checkbox.checked);
    await this.refresh();
  }

  private handleClick(event: MouseEvent): void {
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) return;

    const viewToggle: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.view-toggle');
    if (viewToggle) {
      if (viewToggle.dataset.view === 'cmux') void this.enterCmuxView();
      else this.leaveCmuxView();
      return;
    }

    const cmuxTabBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-tab');
    if (cmuxTabBtn) {
      void this.handleCmuxTabClick(cmuxTabBtn);
      return;
    }

    const cmuxActionBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.cmux-action');
    if (cmuxActionBtn) {
      void this.handleCmuxAction(cmuxActionBtn);
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

    const launchBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.launch-btn');
    if (launchBtn) {
      void this.handleLaunchClick(launchBtn);
      return;
    }

    const stopBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.agent-stop');
    if (stopBtn) {
      void this.handleStopClick(stopBtn);
      return;
    }

    const newRunBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.newrun-launch');
    if (newRunBtn) {
      void this.handleNewRun(newRunBtn);
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
      void this.handleReview(approveBtn, 'APPROVE');
      return;
    }

    const requestChangesBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-request-changes');
    if (requestChangesBtn) {
      void this.handleReview(requestChangesBtn, 'REQUEST_CHANGES');
      return;
    }

    const commentBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-comment');
    if (commentBtn) {
      void this.handleReview(commentBtn, 'COMMENT');
      return;
    }

    const rerunBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-rerun');
    if (rerunBtn) {
      void this.handleRerun(rerunBtn);
      return;
    }

    const reviewAgentBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.pr-review-agent');
    if (reviewAgentBtn) {
      void this.handleReviewAgent(reviewAgentBtn);
      return;
    }

    const configToggle: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.config-toggle');
    if (configToggle) {
      this.toggleConfig();
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
    const bodyEl: HTMLTextAreaElement | null = t.panel.querySelector<HTMLTextAreaElement>('.pr-review-body');
    const body: string = bodyEl?.value ?? '';
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && body.trim() === '') return;
    const result: { ok: boolean; error?: string } = await submitPrReview(t.repo, t.number, event, body);
    if (!result.ok) {
      const reviewEl: HTMLElement | null = t.panel.querySelector<HTMLElement>('.pr-review');
      const errEl: HTMLDivElement = document.createElement('div');
      errEl.className = 'pr-review-error';
      errEl.textContent = result.error ?? 'Review failed.';
      reviewEl?.appendChild(errEl);
      return;
    }
    const refreshed: PrStatusView | null = await getPrStatus(t.repo, t.number);
    t.panel.outerHTML = renderPrPanel(refreshed, this.repos.includes(t.repo));
  }

  private async handleRerun(btn: HTMLElement): Promise<void> {
    const t: { panel: HTMLElement; repo: string; number: number } | null = this.prTarget(btn);
    if (!t) return;
    const feedbackEl: HTMLTextAreaElement | null = t.panel.querySelector<HTMLTextAreaElement>('.pr-rerun-feedback');
    const feedback: string = feedbackEl?.value ?? '';
    if (feedback.trim() === '') return;
    const seq: number = ++this.launchSeq;
    try {
      const result: LaunchResult = await launchRun({ mode: 'rerun', repo: t.repo, prNumber: t.number, feedback });
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, `rerun #${t.number}`);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Re-run failed';
      this.openErrorTab(`rerun #${t.number}`, message);
    }
  }

  private async handleReviewAgent(btn: HTMLElement): Promise<void> {
    const t: { panel: HTMLElement; repo: string; number: number } | null = this.prTarget(btn);
    if (!t) return;
    const seq: number = ++this.launchSeq;
    try {
      const result: LaunchResult = await launchRun({ mode: 'review', repo: t.repo, prNumber: t.number });
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, `review #${t.number}`);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Code review failed';
      this.openErrorTab(`review #${t.number}`, message);
    }
  }

  private async handlePrLookup(): Promise<void> {
    const input: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.pr-lookup-input');
    const result: HTMLElement | null = this.root.querySelector<HTMLElement>('.pr-lookup-result');
    if (!input || !result) return;
    const parsed: { repo: string; number: number } | null = parsePrUrl(input.value);
    if (!parsed) {
      result.innerHTML = '<div class="pr-panel empty-note">Enter a PR URL or owner/repo#number.</div>';
      return;
    }
    const pr: PrStatusView | null = await getPrStatus(parsed.repo, parsed.number);
    result.innerHTML = renderPrPanel(pr, this.repos.includes(parsed.repo));
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
    const ticketEl: HTMLElement | null = row.querySelector<HTMLElement>('.ticket-id');
    const ticketId: string = ticketEl?.textContent ?? runId;
    this.openRunTab(runId, ticketId);
  }

  private openRunTab(runId: string, label: string): void {
    const existing: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === runId);
    if (existing) {
      this.setActiveTab(runId);
      return;
    }
    const run: RunSummary | undefined = this.runs.find((r: RunSummary): boolean => r.id === runId);
    const tab: RunTab = {
      runId,
      label,
      lines: [],
      footer: null,
      pr: run && run.prNumber != null ? { repo: run.repo, number: run.prNumber } : null,
      unsub: null,
      complete: false,
    };
    tab.unsub = openRunStream(runId, (event: RunEvent): void => this.onTabEvent(runId, event));
    this.runTabs.push(tab);
    this.activeTabId = runId;
    this.renderRunDrawer();
    this.rehomeRunDrawer();
    if (tab.pr) void this.loadTabPr(runId, tab.pr.repo, tab.pr.number);
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
    };
    this.runTabs.push(tab);
    this.activeTabId = id;
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private setActiveTab(runId: string): void {
    if (!this.runTabs.some((t: RunTab): boolean => t.runId === runId)) return;
    this.activeTabId = runId;
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private closeRunTab(runId: string): void {
    const idx: number = this.runTabs.findIndex((t: RunTab): boolean => t.runId === runId);
    if (idx < 0) return;
    this.runTabs[idx].unsub?.();
    this.runTabs.splice(idx, 1);
    if (this.activeTabId === runId) {
      const next: RunTab | undefined = this.runTabs[idx] ?? this.runTabs[idx - 1];
      this.activeTabId = next ? next.runId : null;
    }
    this.renderRunDrawer();
    this.rehomeRunDrawer();
  }

  private onTabEvent(runId: string, event: RunEvent): void {
    const tab: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === runId);
    if (!tab) return;
    tab.lines.push(event);
    if (event.kind === 'run-complete') {
      tab.complete = true;
      tab.unsub = null;
    }
    if (runId === this.activeTabId) {
      if (event.kind === 'run-complete') this.renderRunDrawer();
      else this.appendLineDom(event);
    } else if (event.kind === 'run-complete') {
      this.markTabComplete(runId);
    }
    if (event.kind === 'run-complete') void this.finalizeTab(runId);
  }

  private markTabComplete(runId: string): void {
    const dot: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>(
      `.run-tab[data-tabid="${CSS.escape(runId)}"] .run-tab-dot`,
    );
    dot?.classList.add('is-complete');
  }

  private async finalizeTab(runId: string): Promise<void> {
    const summary: RunStatusSummary | null = await getRun(runId);
    const tab: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === runId);
    if (!tab) return;
    tab.footer = summary;
    if (summary && summary.prNumber != null && !tab.pr) {
      tab.pr = { repo: summary.repo, number: summary.prNumber };
    }
    if (runId === this.activeTabId) {
      this.renderFooterDom(tab);
      if (tab.pr) void this.loadTabPr(runId, tab.pr.repo, tab.pr.number);
    }
  }

  private async loadTabPr(runId: string, repo: string, prNumber: number): Promise<void> {
    const pr: PrStatusView | null = await getPrStatus(repo, prNumber);
    if (runId !== this.activeTabId) return;
    const prEl: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-pr');
    if (prEl) prEl.innerHTML = renderPrPanel(pr, this.repos.includes(repo));
  }

  private rehomeRunDrawer(): void {
    const slot: HTMLElement | null = this.root.querySelector<HTMLElement>('.runs-drawer-slot');
    if (slot && this.runDrawerEl.parentElement !== slot) slot.appendChild(this.runDrawerEl);
    this.runDrawerEl.hidden = this.runTabs.length === 0;
  }

  private renderRunDrawer(): void {
    const tabsView: RunTabView[] = this.runTabs.map((t: RunTab): RunTabView => ({
      id: t.runId,
      label: t.label,
      complete: t.complete,
    }));
    this.runDrawerEl.innerHTML = renderRunsDrawer(tabsView, this.activeTabId);
    this.runDrawerEl.hidden = this.runTabs.length === 0;
    const active: RunTab | undefined = this.runTabs.find((t: RunTab): boolean => t.runId === this.activeTabId);
    if (!active) return;
    const body: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    if (body) {
      for (const event of active.lines) body.appendChild(this.lineEl(event));
      body.scrollTop = body.scrollHeight;
    }
    this.renderFooterDom(active);
    if (active.pr) void this.loadTabPr(active.runId, active.pr.repo, active.pr.number);
  }

  private lineEl(event: RunEvent): HTMLDivElement {
    const line: HTMLDivElement = document.createElement('div');
    line.className = `run-line run-line-${event.kind}`;
    line.textContent = event.text;
    return line;
  }

  private appendLineDom(event: RunEvent): void {
    const body: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-body');
    if (!body) return;
    body.appendChild(this.lineEl(event));
    body.scrollTop = body.scrollHeight;
  }

  private renderFooterDom(tab: RunTab): void {
    const footer: HTMLElement | null = this.runDrawerEl.querySelector<HTMLElement>('.run-drawer-footer');
    if (!footer) return;
    footer.textContent = '';
    const summary: RunStatusSummary | null = tab.footer;
    if (!summary) return;

    const statusLine: HTMLDivElement = document.createElement('div');
    statusLine.className = 'run-drawer-footer-status';
    statusLine.textContent = `Ticket status: ${deriveTicketStatus(summary)}`;
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
      link.textContent = `PR #${summary.prNumber}`;
      prLine.appendChild(link);
    } else {
      prLine.textContent = `PR #${summary.prNumber}`;
    }
    footer.appendChild(prLine);
  }

  private toggleConfig(): void {
    this.configCollapsed = !this.configCollapsed;
    saveConfigCollapsed(this.configCollapsed);
    const panel: HTMLElement | null = this.root.querySelector<HTMLElement>('.config-panel');
    panel?.classList.toggle('is-collapsed', this.configCollapsed);
    const btn: HTMLElement | null = this.root.querySelector<HTMLElement>('.config-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', this.configCollapsed ? 'false' : 'true');
      btn.innerHTML = this.configCollapsed ? '&#9656;' : '&#9662;';
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
      const result: LaunchResult = await launchAgent(ticketId, title ?? ticketId, repo);
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, ticketId);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Launch failed';
      this.openErrorTab(ticketId, message);
    } finally {
      btn.disabled = false;
    }
  }

  private buildNewRunPayload(mode: 'ticket' | 'freeform'): { body: LaunchRunBody; ticketId: string; title: string } | null {
    const repoSelect: HTMLSelectElement | null = this.root.querySelector<HTMLSelectElement>('.newrun-repo');
    const repo: string = repoSelect?.value ?? '';
    if (!repo) return null;

    if (mode === 'freeform') {
      const taskEl: HTMLTextAreaElement | null = this.root.querySelector<HTMLTextAreaElement>('.newrun-task');
      const task: string = taskEl?.value ?? '';
      if (task.trim() === '') return null;
      return { body: { repo, task, mode: 'freeform' }, ticketId: 'freeform', title: task };
    }

    const ticketEl: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-ticket');
    const titleEl: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-title');
    const ticketId: string = ticketEl?.value ?? '';
    if (ticketId.trim() === '') return null;
    const title: string = titleEl?.value || ticketId;
    return { body: { ticketId, title, repo, mode: 'ticket' }, ticketId, title };
  }

  private async handleNewRun(btn: HTMLButtonElement): Promise<void> {
    const modeInput: HTMLInputElement | null = this.root.querySelector<HTMLInputElement>('.newrun-mode:checked');
    const mode: 'ticket' | 'freeform' = modeInput?.value === 'freeform' ? 'freeform' : 'ticket';
    const payload: { body: LaunchRunBody; ticketId: string; title: string } | null =
      this.buildNewRunPayload(mode);
    if (!payload) return;
    const { body, ticketId, title } = payload;

    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = await launchRun(body);
      if (seq !== this.launchSeq) return;
      this.openRunTab(result.runId, ticketId || title);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Launch failed';
      this.openErrorTab(ticketId || title, message);
    } finally {
      btn.disabled = false;
    }
  }

  private async handleConfigSave(btn: HTMLButtonElement): Promise<void> {
    const row: HTMLElement | null = btn.closest<HTMLElement>('.config-row');
    const key: string | undefined = row?.dataset.key;
    const input: HTMLInputElement | null = row?.querySelector<HTMLInputElement>('.config-input') ?? null;
    if (!key || !input) return;
    const errorEl: HTMLElement | null = row?.querySelector<HTMLElement>('.config-error') ?? null;
    if (errorEl) errorEl.textContent = '';
    btn.disabled = true;
    try {
      const result: { ok: boolean; error?: string } = await setConfig(key, input.value);
      if (!result.ok) {
        if (errorEl) errorEl.textContent = result.error ?? 'Save failed.';
        return;
      }
      await this.refresh();
    } finally {
      btn.disabled = false;
    }
  }

}

export function bootstrap(): void {
  const root: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('missing #app root element');
  const view: DashboardView = new DashboardView(root);
  void view.refresh();
  setInterval(() => void view.refresh(), POLL_MS);
}

if (import.meta.env.MODE !== 'test') bootstrap();
