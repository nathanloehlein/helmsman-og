import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { escapeHtml as esc } from './logic/html';
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
}

const ICON_CHECK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>'

const ICON_ACTIVE: string =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3.4"/></svg>'

const ICON_LOCK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V5.1a2.5 2.5 0 0 1 5 0V7"/></svg>'

function formatCycle(minutes: number): string {
  if (minutes <= 0) return '—'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) {
    const hours: number = minutes / 60
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }
  return `${(minutes / 1440).toFixed(1)}d`
};

function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo
}

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
  filterRepo: string | null = null,
): void {
  const queue = sortByPriority(data.queue);

  const shippedRepos: string[] = Array.from(
    new Set(data.shipped.map((pr) => pr.repo).filter((r): r is string => !!r)),
  ).sort();
  const activeRepo: string | null =
    filterRepo && shippedRepos.includes(filterRepo) ? filterRepo : null;
  const visibleShipped = activeRepo
    ? data.shipped.filter((pr) => pr.repo === activeRepo)
    : data.shipped;
  const displayRepo: string = activeRepo ? shortRepo(activeRepo) : data.repo;

  const repoOptions: string = ['<option value="">All repos</option>']
    .concat(
      shippedRepos.map(
        (repo) =>
          `<option value="${esc(repo)}"${repo === activeRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');

  const queueItems = queue.length
    ? queue
        .map(
          (ticket) => `
      <li class="queue-item">
        <div class="queue-row1">
          <span class="ticket-id">${esc(ticket.id)}</span>
          <span class="pri-chip ${PRIORITY_CLASS[ticket.priority]}">${ticket.priority}</span>
        </div>
        <span class="queue-title">${esc(ticket.title)}</span>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No backlog tickets assigned.</li>';

  const stepRows = data.steps
    .map(
      (step) => `
      <div class="step step-${step.state}">
        <span class="step-time mono">${formatRelativeTime(step.time, now)}</span>
        <span class="step-icon">${step.state === 'done' ? ICON_CHECK : ICON_ACTIVE}</span>
        <span class="step-text">${step.text}</span>
      </div>`,
    )
    .join('');

  const shippedCards = visibleShipped
    .map((pr) => {
      const status = PR_STATUS[pr.status];
      const repoShort: string = pr.repo ? shortRepo(pr.repo) : '';
      const subParts: string[] = [
        pr.ticketId !== '—' ? esc(pr.ticketId) : '',
        repoShort ? esc(repoShort) : '',
        `opened ${formatRelativeTime(pr.openedAt, now)}`,
      ].filter((part) => part !== '');
      return `
      <div class="pr-card">
        <span class="pr-num mono">#${pr.number}</span>
        <div class="pr-title-line">
          <span class="pr-title">${esc(pr.title)}</span>
          <span class="pr-sub">${subParts.join(' &middot; ')}</span>
        </div>
        <span class="chip ${status.chipClass}">${status.label}</span>
      </div>`;
    })
    .join('') || '<div class="empty-note">No recent pull requests.</div>';

  const activityLines = data.activity.length
    ? data.activity
        .map(
          (event) => `
      <div class="feed-line">
        <span class="feed-time mono">${formatRelativeTime(event.time, now)}</span>
        <span class="feed-text${event.accent ? ' tag-accent' : ''}">${event.text}</span>
      </div>`,
        )
        .join('')
    : '<div class="empty-note">No recent activity.</div>';

  const banner: string =
    degraded.length > 0
      ? `<div class="degraded-banner">Showing sample data for: ${degraded.join(', ')} — check server credentials.</div>`
      : '';

  const claimed: string = data.steps[0]
    ? ` &middot; claimed ${formatRelativeTime(data.steps[0].time, now)}`
    : '';

  root.innerHTML = `
    <div class="wrap">
      ${banner}
      <div class="topbar">
        <span class="pulse-dot" aria-hidden="true"></span>
        <div class="status-text"><strong>Working</strong>${claimed}</div>
        <div class="topbar-sep"></div>
        <span class="repo-tag">${esc(displayRepo)}</span>
        <div class="topbar-sep"></div>
        <span class="brand">BACKLOG RUNNER</span>
        <div class="topbar-stats">
          <div class="mini-stat"><span class="num mono">${data.stats.completedToday}</span><span class="lbl">Shipped today</span></div>
          <div class="mini-stat"><span class="num mono">${data.stats.awaitingReview}</span><span class="lbl">Awaiting review</span></div>
          <div class="mini-stat"><span class="num mono">${formatCycle(data.stats.avgCycleMinutes)}</span><span class="lbl">Avg cycle</span></div>
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
                <span class="ticket-id">${esc(data.currentTicket.id)}</span>
                <h2 class="ticket-headline">${esc(data.currentTicket.title)}</h2>
                <div class="ticket-meta">
                  <span class="repo-tag mono">${esc(data.currentTicket.repo)}</span>
                </div>
              </div>
            </div>
            <div class="step-list">${stepRows}</div>
            <div class="perm-note">
              ${ICON_LOCK}
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
            <div class="stat-row"><span class="stat-label">Avg cycle time</span><span class="stat-value">${formatCycle(data.stats.avgCycleMinutes)}</span></div>
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
          <div class="panel-head-controls">
            <select class="repo-select" aria-label="Filter by repository">${repoOptions}</select>
            <span class="panel-count mono">${visibleShipped.length}</span>
          </div>
        </div>
        <div class="shipped-grid">${shippedCards}</div>
      </div>
    </div>`;
}
