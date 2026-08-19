import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard, ICON_CLOSE } from './render';
import type { DashboardSnapshot } from './data/mock';
import {
  launchAgent,
  openRunStream,
  getRun,
  listRuns,
  type LaunchResult,
  type RunEvent,
  type RunStatusSummary,
  type RunSummary,
} from './data/agents';

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
    this.runs = await listRuns();
    this.paint();
  }

  private paint(): void {
    if (!this.snapshot) return;
    renderDashboard(this.root, this.snapshot, new Date(), this.degraded, this.repos, this.selectedRepo, this.runs);
    const select: HTMLSelectElement | null =
      this.root.querySelector<HTMLSelectElement>('.repo-select');
    if (select) {
      select.addEventListener('change', () => {
        this.selectedRepo = select.value || null;
        void this.refresh();
      });
    }
  }

  private stopActiveStream(): void {
    this.activeStreamUnsubscribe?.();
    this.activeStreamUnsubscribe = null;
  }

  private handleClick(event: MouseEvent): void {
    const target: EventTarget | null = event.target;
    if (!(target instanceof Element)) return;
    const launchBtn: HTMLButtonElement | null = target.closest<HTMLButtonElement>('.launch-btn');
    if (launchBtn) void this.handleLaunchClick(launchBtn);
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
      this.activeRunId = result.runId;
      this.openDrawer(ticketId, title ?? ticketId);
      this.activeStreamUnsubscribe = openRunStream(result.runId, (event: RunEvent): void => this.appendLine(event));
    } catch (err: unknown) {
      if (seq !== this.launchSeq) return;
      const message: string = err instanceof Error ? err.message : 'Launch failed';
      this.openDrawer(ticketId, title ?? ticketId);
      this.appendLine({ id: 0, runId: '', ts: new Date().toISOString(), kind: 'error', text: message });
    } finally {
      btn.disabled = false;
    }
  }

  private openDrawer(ticketId: string, title: string): void {
    this.drawerTitle.textContent = `${ticketId} — ${title}`;
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
    if (event.kind === 'run-complete') void this.renderFooter(event.runId);
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
