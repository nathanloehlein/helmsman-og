import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard } from './render';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

async function tick(target: HTMLDivElement): Promise<void> {
  try {
    const { snapshot, degraded }: DashboardResponse = await loadDashboard();
    renderDashboard(target, snapshot, new Date(), degraded);
  } catch {}
}

void tick(root);
setInterval(() => void tick(root), POLL_MS);
