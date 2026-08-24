import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard, ICON_CLOSE } from './render';
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

function deriveTicketStatus(summary: RunStatusSummary): string {
  if (summary.status === 'succeeded' && summary.prNumber != null) return 'In Review';
  if (summary.status === 'succeeded') return 'Succeeded';
  if (summary.status === 'failed') return 'Failed';
  if (summary.status === 'stopped') return 'Stopped';
  return summary.status;
}

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly drawerTitle: HTMLElement;
  private readonly drawerBody: HTMLElement;
  private readonly drawerFooter: HTMLElement;
  private snapshot: DashboardSnapshot | null = null;
  private degraded: string[] = [];
  private repos: string[] = [];
  private selectedRepo: string | null = null;
  private runs: RunSummary[] = [];
  private autoClaimRepos: string[] = [];
  private caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null };
  private uiConfig: UiConfig = { config: {}, overridden: [] };
  private activeStreamUnsubscribe: (() => void) | null = null;
  private activeRunId: string | null = null;
  private launchSeq: number = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.addEventListener('click', (event: MouseEvent): void => this.handleClick(event));

    const drawer: HTMLDivElement = document.createElement('div');
    drawer.className = 'run-drawer';
    drawer.hidden = true;
    drawer.innerHTML = `
      <div class="run-drawer-head">
        <span class="run-drawer-title mono"></span>
        <button class="run-drawer-close" aria-label="Close">${ICON_CLOSE}</button>
      </div>
      <div class="run-drawer-body mono"></div>
      <div class="run-drawer-footer mono"></div>`;
    const titleEl: HTMLElement | null = drawer.querySelector<HTMLElement>('.run-drawer-title');
    const bodyEl: HTMLElement | null = drawer.querySelector<HTMLElement>('.run-drawer-body');
    const footerEl: HTMLElement | null = drawer.querySelector<HTMLElement>('.run-drawer-footer');
    const closeBtn: HTMLButtonElement | null = drawer.querySelector<HTMLButtonElement>('.run-drawer-close');
    if (!titleEl || !bodyEl || !footerEl || !closeBtn) throw new Error('run drawer construction failed');
    closeBtn.addEventListener('click', (): void => this.closeDrawer());
    document.body.appendChild(drawer);
    this.drawer = drawer;
    this.drawerTitle = titleEl;
    this.drawerBody = bodyEl;
    this.drawerFooter = footerEl;
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
    this.paint();
  }

  private paint(): void {
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
    );
    const select: HTMLSelectElement | null =
      this.root.querySelector<HTMLSelectElement>('.repo-select');
    if (select) {
      select.addEventListener('change', () => {
        this.selectedRepo = select.value || null;
        void this.refresh();
      });
    }
    const autoClaimCheckbox: HTMLInputElement | null =
      this.root.querySelector<HTMLInputElement>('.auto-claim-toggle');
    if (autoClaimCheckbox) {
      autoClaimCheckbox.addEventListener('change', () => void this.handleAutoClaimChange(autoClaimCheckbox));
    }
  }

  private async handleAutoClaimChange(checkbox: HTMLInputElement): Promise<void> {
    const repo: string | null = this.selectedRepo;
    if (!repo) return;
    await setAutoClaim(repo, checkbox.checked);
    await this.refresh();
  }

  private stopActiveStream(): void {
    this.activeStreamUnsubscribe?.();
    this.activeStreamUnsubscribe = null;
  }

  private handleClick(event: MouseEvent): void {
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) return;

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

    const runRow: HTMLElement | null = target.closest<HTMLElement>('.agent-row, .recent-run');
    if (runRow) this.handleRunRowClick(runRow);
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

    this.stopActiveStream();
    ++this.launchSeq;
    this.openRunDrawerAndStream(runId, ticketId, '');
  }

  private openRunDrawerAndStream(runId: string, ticketId: string, title: string): void {
    this.activeRunId = runId;
    this.openDrawer(ticketId, title);
    this.activeStreamUnsubscribe = openRunStream(runId, (event: RunEvent): void => this.appendLine(event));
  }

  private async handleLaunchClick(btn: HTMLButtonElement): Promise<void> {
    const ticketId: string | undefined = btn.dataset.ticket;
    const title: string | undefined = btn.dataset.title;
    const repo: string | undefined = btn.dataset.repo;
    if (!ticketId || !repo) return;
    this.stopActiveStream();
    this.activeRunId = null;
    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = await launchAgent(ticketId, title ?? ticketId, repo);
      if (seq !== this.launchSeq) return;
      this.openRunDrawerAndStream(result.runId, ticketId, title ?? ticketId);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Launch failed';
      this.openDrawer(ticketId, title ?? ticketId);
      this.appendLine({ id: 0, runId: '', ts: new Date().toISOString(), kind: 'error', text: message });
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

    this.stopActiveStream();
    this.activeRunId = null;
    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = await launchRun(body);
      if (seq !== this.launchSeq) return;
      this.openRunDrawerAndStream(result.runId, ticketId, title);
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Launch failed';
      this.openDrawer(ticketId, title);
      this.appendLine({ id: 0, runId: '', ts: new Date().toISOString(), kind: 'error', text: message });
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

  private openDrawer(ticketId: string, title: string): void {
    this.drawerTitle.textContent = title ? `${ticketId} — ${title}` : ticketId;
    this.drawerBody.innerHTML = '';
    this.drawerFooter.textContent = '';
    this.drawer.hidden = false;
  }

  private closeDrawer(): void {
    this.stopActiveStream();
    this.activeRunId = null;
    this.drawer.hidden = true;
  }

  private appendLine(event: RunEvent): void {
    const line: HTMLDivElement = document.createElement('div');
    line.className = `run-line run-line-${event.kind}`;
    line.textContent = event.text;
    this.drawerBody.appendChild(line);
    this.drawerBody.scrollTop = this.drawerBody.scrollHeight;
    if (event.kind === 'run-complete') void this.renderFooter(this.activeRunId ?? '');
  }

  private async renderFooter(runId: string): Promise<void> {
    if (!runId || runId !== this.activeRunId) return;
    const summary: RunStatusSummary | null = await getRun(runId);
    if (runId !== this.activeRunId) return;
    this.paintFooter(summary);
  }

  private paintFooter(summary: RunStatusSummary | null): void {
    this.drawerFooter.textContent = '';
    if (!summary) return;

    const statusLine: HTMLDivElement = document.createElement('div');
    statusLine.className = 'run-drawer-footer-status';
    statusLine.textContent = `Ticket status: ${deriveTicketStatus(summary)}`;
    this.drawerFooter.appendChild(statusLine);

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
    this.drawerFooter.appendChild(prLine);
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
