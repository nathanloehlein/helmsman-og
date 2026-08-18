import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard, ICON_CLOSE } from './render';
import type { DashboardSnapshot } from './data/mock';
import { launchAgent, openRunStream, type LaunchResult, type RunEvent } from './data/agents';

export class DashboardView {
  private readonly root: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly drawerTitle: HTMLElement;
  private readonly drawerBody: HTMLElement;
  private snapshot: DashboardSnapshot | null = null;
  private degraded: string[] = [];
  private repos: string[] = [];
  private selectedRepo: string | null = null;
  private activeStreamUnsubscribe: (() => void) | null = null;
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
      <div class="run-drawer-body mono"></div>`;
    const titleEl: HTMLElement | null = drawer.querySelector<HTMLElement>('.run-drawer-title');
    const bodyEl: HTMLElement | null = drawer.querySelector<HTMLElement>('.run-drawer-body');
    const closeBtn: HTMLButtonElement | null = drawer.querySelector<HTMLButtonElement>('.run-drawer-close');
    if (!titleEl || !bodyEl || !closeBtn) throw new Error('run drawer construction failed');
    closeBtn.addEventListener('click', (): void => this.closeDrawer());
    document.body.appendChild(drawer);
    this.drawer = drawer;
    this.drawerTitle = titleEl;
    this.drawerBody = bodyEl;
  }

  async refresh(): Promise<void> {
    const response: DashboardResponse | null = await loadDashboard(this.selectedRepo).catch(() => null);
    if (response) {
      this.snapshot = response.snapshot;
      this.degraded = response.degraded;
      this.repos = response.repos;
      this.selectedRepo = response.selectedRepo;
    }
    this.paint();
  }

  private paint(): void {
    if (!this.snapshot) return;
    renderDashboard(this.root, this.snapshot, new Date(), this.degraded, this.repos, this.selectedRepo);
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
    const seq: number = ++this.launchSeq;
    btn.disabled = true;
    try {
      const result: LaunchResult = await launchAgent(ticketId, title ?? ticketId, repo);
      if (seq !== this.launchSeq) return;
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
    this.drawer.hidden = false;
  }

  private closeDrawer(): void {
    this.stopActiveStream();
    this.drawer.hidden = true;
  }

  private appendLine(event: RunEvent): void {
    const line: HTMLDivElement = document.createElement('div');
    line.className = `run-line run-line-${event.kind}`;
    line.textContent = event.text;
    this.drawerBody.appendChild(line);
    this.drawerBody.scrollTop = this.drawerBody.scrollHeight;
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
