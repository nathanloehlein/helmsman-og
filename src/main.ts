import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard } from './render';
import type { DashboardSnapshot } from './data/mock';

class DashboardView {
  private readonly root: HTMLElement;
  private snapshot: DashboardSnapshot | null = null;
  private degraded: string[] = [];
  private repos: string[] = [];
  private selectedRepo: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
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
}

const root: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

const view: DashboardView = new DashboardView(root);
void view.refresh();
setInterval(() => void view.refresh(), POLL_MS);
