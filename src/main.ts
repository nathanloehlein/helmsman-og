import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard } from './render';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

async function tick(target: HTMLDivElement): Promise<void> {
  const response: DashboardResponse | null = await loadDashboard().catch(() => null);
  if (!response) return;
  renderDashboard(target, response.snapshot, new Date(), response.degraded);
}

void tick(root);
setInterval(() => void tick(root), POLL_MS);
