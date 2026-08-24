import type { DashboardSnapshot } from './data/mock';
import { formatRelativeTime } from './logic/time';
import { sortByPriority } from './logic/queue';
import { escapeHtml as esc } from './logic/html';
import type { PrStatus, Priority } from './types';
import type { AgentCaps, RunSummary } from './data/agents';
import type { UiConfig } from './data/config';

const PRIORITY_CLASS: Record<Priority, string> = { P1: 'pri-p1', P2: 'pri-p2', P3: 'pri-p3' };

const PR_STATUS: Record<PrStatus, { label: string; chipClass: string }> = {
  'in-review': { label: 'In review', chipClass: 'chip-review' },
  merged: { label: 'Merged', chipClass: 'chip-done' },
  'changes-requested': { label: 'Changes requested', chipClass: 'chip-blocked' },
}

const RUN_STATUS_CHIP: Record<string, { label: string; chipClass: string }> = {
  succeeded: { label: 'Succeeded', chipClass: 'chip-done' },
  failed: { label: 'Failed', chipClass: 'chip-blocked' },
  stopped: { label: 'Stopped', chipClass: 'chip-progress' },
}

const ICON_LOCK: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V5.1a2.5 2.5 0 0 1 5 0V7"/></svg>'

const ICON_STOP: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2"/></svg>'

export const ICON_CLOSE: string =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

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
  repos: string[] = [],
  selectedRepo: string | null = null,
  runs: RunSummary[] = [],
  autoClaimRepos: string[] = [],
  caps: AgentCaps = { maxAttempts: 1, maxCostUsd: null },
  uiConfig: UiConfig = { config: {}, overridden: [] },
): void {
  const queue = sortByPriority(data.queue);
  const activeRuns: RunSummary[] = runs.filter((r) => r.status === 'running');
  const terminalRuns: RunSummary[] = runs.filter((r) => r.status !== 'running');

  const repoOptions: string = ['<option value="">All repos</option>']
    .concat(
      repos.map(
        (repo) =>
          `<option value="${esc(repo)}"${repo === selectedRepo ? ' selected' : ''}>${esc(shortRepo(repo))}</option>`,
      ),
    )
    .join('');

  const autoClaimToggle: string = selectedRepo
    ? `<label class="auto-claim"><input type="checkbox" class="auto-claim-toggle"${autoClaimRepos.includes(selectedRepo) ? ' checked' : ''}><span>Auto-claim</span></label>`
    : '';

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
        <button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="Launch agent for ${esc(ticket.id)}">Launch</button>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No backlog tickets assigned.</li>';

  const agentRows: string = activeRuns.length
    ? activeRuns
        .map(
          (run) => `
      <li class="agent-row" data-runid="${esc(run.id)}">
        <span class="ticket-id">${esc(run.ticketId)}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        <span class="chip chip-progress">Running</span>
        <span class="agent-elapsed mono">${formatRelativeTime(run.startedAt, now)}</span>
        ${caps.maxAttempts > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}/${caps.maxAttempts}</span>` : run.attempt > 1 ? `<span class="agent-attempt mono">&times;${run.attempt}</span>` : ''}
        ${run.costUsd != null ? `<span class="agent-cost mono">$${run.costUsd.toFixed(2)}${caps.maxCostUsd != null ? `/$${caps.maxCostUsd.toFixed(2)}` : ''}</span>` : ''}
        <button class="agent-stop" data-runid="${esc(run.id)}" aria-label="Stop run ${esc(run.ticketId)}">${ICON_STOP}</button>
      </li>`,
        )
        .join('')
    : '<li class="empty-note">No agents running.</li>';

  const shippedCards = data.shipped
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

  const newRunRepoOptions: string = repos
    .map((repo) => `<option value="${esc(repo)}">${esc(shortRepo(repo))}</option>`)
    .join('');

  const recentRunItems: string = terminalRuns.length
    ? terminalRuns
        .map((run) => {
          const statusInfo = RUN_STATUS_CHIP[run.status] ?? { label: esc(run.status), chipClass: 'chip-progress' };
          const costText: string = run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '&mdash;';
          const prLink: string =
            run.prNumber != null
              ? `<a class="recent-run-pr" href="https://github.com/${esc(run.repo)}/pull/${run.prNumber}" target="_blank" rel="noopener">#${run.prNumber}</a>`
              : '';
          return `
      <li class="recent-run" data-runid="${esc(run.id)}">
        <span class="ticket-id">${esc(run.ticketId || 'freeform')}</span>
        <span class="agent-repo mono">${esc(shortRepo(run.repo))}</span>
        <span class="chip ${statusInfo.chipClass}">${statusInfo.label}</span>
        <span class="agent-cost mono">${costText}</span>
        ${prLink}
      </li>`;
        })
        .join('')
    : '<li class="empty-note">No past runs.</li>';

  const configEntries: [string, unknown][] = Object.entries(uiConfig.config ?? {});
  const configRows: string = configEntries.length
    ? configEntries
        .map(([key, value]) => {
          const isOverridden: boolean = (uiConfig.overridden ?? []).includes(key);
          return `
      <div class="config-row" data-key="${esc(key)}">
        <span class="config-key mono">${esc(key)}${isOverridden ? ' <span class="config-overridden">(overridden)</span>' : ''}</span>
        <input class="config-input" type="text" value="${esc(String(value ?? ''))}">
        <button class="config-save" data-key="${esc(key)}">Save</button>
        <span class="config-error" role="alert"></span>
      </div>`;
        })
        .join('')
    : '<div class="empty-note">No configuration keys.</div>';

  root.innerHTML = `
    <div class="wrap">
      ${banner}
      <div class="topbar">
        <span class="pulse-dot" aria-hidden="true"></span>
        <div class="status-text"><strong>Working</strong>${claimed}</div>
        <div class="topbar-sep"></div>
        <select class="repo-select" aria-label="Scope dashboard by repository">${repoOptions}</select>
        ${autoClaimToggle}
        <div class="topbar-sep"></div>
        <span class="brand">BACKLOG RUNNER</span>
        <div class="topbar-stats">
          <div class="mini-stat"><span class="num mono">${data.stats.completedToday}</span><span class="lbl">Shipped today</span></div>
          <div class="mini-stat"><span class="num mono">${data.stats.awaitingReview}</span><span class="lbl">Awaiting review</span></div>
          <div class="mini-stat"><span class="num mono">${formatCycle(data.stats.avgCycleMinutes)}</span><span class="lbl">Avg cycle</span></div>
        </div>
      </div>

      <div class="panel newrun-panel">
        <div class="panel-head">
          <span class="panel-title">New run</span>
        </div>
        <div class="newrun-body">
          <div class="newrun-mode-toggle">
            <label class="newrun-mode-label">
              <input type="radio" class="newrun-mode" name="newrun-mode" value="ticket" checked>
              <span>Ticket</span>
            </label>
            <label class="newrun-mode-label">
              <input type="radio" class="newrun-mode" name="newrun-mode" value="freeform">
              <span>Free-form</span>
            </label>
          </div>
          <div class="newrun-fields">
            <input class="newrun-ticket" type="text" placeholder="Ticket ID (e.g. ABC-123)">
            <input class="newrun-title" type="text" placeholder="Title (optional)">
            <textarea class="newrun-task" placeholder="Describe the task..."></textarea>
            <select class="newrun-repo" aria-label="Repository for new run">${newRunRepoOptions}</select>
            <button class="newrun-launch">Launch run</button>
          </div>
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
            <span class="panel-title">Agents running</span>
            <span class="panel-count mono">${activeRuns.length}</span>
          </div>
          <div class="agents-body">
            <ul class="agent-list">${agentRows}</ul>
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

      <div class="panel panel-shipped">
        <div class="panel-head">
          <span class="panel-title">Recently shipped</span>
          <span class="panel-count mono">${data.shipped.length}</span>
        </div>
        <div class="shipped-grid">${shippedCards}</div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Recent runs</span>
          <span class="panel-count mono">${terminalRuns.length}</span>
        </div>
        <ul class="recent-runs-list">${recentRunItems}</ul>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Config</span>
        </div>
        <div class="config-warning">Adapter and <span class="mono">AGENT_CMD</span> can run arbitrary commands &mdash; change with care. Auto-claim interval changes apply on restart.</div>
        <div class="config-list">${configRows}</div>
      </div>
    </div>`;
}
