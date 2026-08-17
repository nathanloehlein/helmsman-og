import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard } from './render';
import type { DashboardSnapshot } from './data/mock';

class DashboardView {
  private readonly root: HTMLElement;
  private snapshot: DashboardSnapshot | null = null;
  private degraded: string[] = [];
  private selectedRepo: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async refresh(): Promise<void> {
    const response: DashboardResponse | null = await loadDashboard().catch(() => null);
    if (response) {
      this.snapshot = response.snapshot;
      this.degraded = response.degraded;
    }
    this.paint();
  }

  private paint(): void {
    if (!this.snapshot) return;
    renderDashboard(this.root, this.snapshot, new Date(), this.degraded, this.selectedRepo);
    const select: HTMLSelectElement | null =
      this.root.querySelector<HTMLSelectElement>('.repo-select');
    if (select) {
      select.addEventListener('change', () => {
        this.selectedRepo = select.value || null;
        this.paint();
      });
    }
  }
}

const root: HTMLDivElement | null = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

const view: DashboardView = new DashboardView(root);
void view.refresh();
setInterval(() => void view.refresh(), POLL_MS);
