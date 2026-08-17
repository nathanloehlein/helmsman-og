import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import type { PrStatus, Priority, TicketStatus } from './types';

const PRIORITY_CLASS: Record<Priority, string> = { P1: 'pri-p1', P2: 'pri-p2', P3: 'pri-p3' };

const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done',
};

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { label: 'In review', chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
};

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
         role="img" aria-label="Tickets shipped per day, last 7 days">
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

export function renderDashboard(
  root: HTMLElement,
  data: DashboardSnapshot,
  now: Date,
  degraded: string[] = [],
): void {
  const queue = sortByPriority(data.queue);

  const queueItems = queue
    .map(
      (ticket) => `
      <li class="queue-item">
        <div class="queue-row1">
          <span class="ticket-id">${ticket.id}</span>
          <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        </div>
        <span class="queue-title">${ticket.title}</span>
      </li>`,
    )
    .join('');

  const stepRows = data.steps
    .map(
      (step) => `
      <div class="step step-${step.state}">
        <span class="step-time mono">${formatRelativeTime(step.time, now)}</span>
        <span class="step-icon">${step.state === 'done' ? '&#10003;' : '&#8226;'}</span>
        <span class="step-text">${step.text}</span>
      </div>`,
    )
    .join('');

  const shippedCards = data.shipped
    .map((pr) => {
      const status = PR_STATUS[pr.status];
      return `
      <div class="pr-card">
        <span class="pr-num mono">#${pr.number}</span>
        <div class="pr-title-line">
          <span class="pr-title">${pr.title}</span>
          <span class="pr-sub">${pr.ticketId} &middot; opened ${formatRelativeTime(pr.openedAt, now)}</span>
        </div>
        <span class="chip ${status.chipClass}">${status.label}</span>
      </div>`;
    })
    .join('');

  const activityLines = data.activity
    .map(
      (event) => `
      <div class="feed-line">
        <span class="feed-time mono">${formatRelativeTime(event.time, now)}</span>
        <span class="feed-text${event.accent ? ' tag-accent' : ''}">${event.text}</span>
      </div>`,
    )
    .join('');

  const banner: string =
    degraded.length > 0
      ? `<div class="degraded-banner">Showing sample data for: ${degraded.join(', ')} — check server credentials.</div>`
      : '';

  root.innerHTML = `
    <div class="wrap">
      ${banner}
      <div class="topbar">
        <span class="pulse-dot" aria-hidden="true"></span>
        <div class="status-text"><strong>Working</strong> &middot; claimed ${formatRelativeTime(data.steps[0]!.time, now)}</div>
        <div class="topbar-sep"></div>
        <span class="repo-tag">${data.repo}</span>
        <div class="topbar-sep"></div>
        <span class="brand">BACKLOG RUNNER</span>
        <div class="topbar-stats">
          <div class="mini-stat"><span class="num mono">${data.stats.completedToday}</span><span class="lbl">Shipped today</span></div>
          <div class="mini-stat"><span class="num mono">${data.stats.awaitingReview}</span><span class="lbl">Awaiting review</span></div>
          <div class="mini-stat"><span class="num mono">${data.stats.avgCycleMinutes}m</span><span class="lbl">Avg cycle</span></div>
        </div>
      </div>

      <div class="grid">
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Backlog queue</span>
            <span class="panel-count mono">${queue.length}</span>
          </div>
          <ul class="queue-list">${queueItems}</ul>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">Working on</span>
            <span class="chip chip-progress">${TICKET_STATUS_LABEL[data.currentTicket.status]}</span>
          </div>
          <div class="working-body">
            <div class="ticket-head">
              <div>
                <span class="ticket-id">${data.currentTicket.id}</span>
                <h2 class="ticket-headline">${data.currentTicket.title}</h2>
                <div class="ticket-meta">
                  <span class="repo-tag mono">${data.currentTicket.repo}</span>
                </div>
              </div>
            </div>
            <div class="step-list">${stepRows}</div>
            <div class="perm-note">
              <span>&#128274;</span>
              <span>Read/write scoped to this branch only. Merge requires human approval &mdash; agent never merges to main.</span>
            </div>
          </div>
        </div>

        <div class="rail">
          <div class="panel stat-block">
            <div class="panel-head" style="padding:0; border:none;">
              <span class="panel-title">Today</span>
            </div>
            <div class="stat-row"><span class="stat-label">Tickets completed</span><span class="stat-value">${data.stats.completedToday}</span></div>
            <div class="stat-row"><span class="stat-label">PRs awaiting review</span><span class="stat-value">${data.stats.awaitingReview}</span></div>
            <div class="stat-row"><span class="stat-label">Avg cycle time</span><span class="stat-value">${data.stats.avgCycleMinutes}m</span></div>
            <div class="spark-wrap">
              <div class="spark-label">Throughput, last 7 days</div>
              ${buildSparkline(data.throughput7d)}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><span class="panel-title">Activity feed</span></div>
            <div class="feed">${activityLines}</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Recently shipped</span>
          <span class="panel-count mono">${data.shipped.length}</span>
        </div>
        <div class="shipped-grid">${shippedCards}</div>
      </div>
    </div>`;
}
