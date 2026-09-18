import { safePrUrl, safeSlackUrl, type SlackHealth, type SlackNotification, type SlackState } from './data/slack';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import { term } from './logic/terminology';
import { formatRelativeTime } from './logic/time';
import './slack.css';

const labels = (): Record<SlackNotification['status'], string> => ({
  queued: `${term('review')} queued`, launched: `${term('review')} started`,
  failed: `${term('review')}: ${term('failed')}`, blocked: `${term('review')} blocked`,
});

function renderNotification(item: SlackNotification, now: Date, selectedRepo: string | null): string {
  const slackSource = safeSlackUrl(item.sourceUrl);
  const source = slackSource ?? safePrUrl(item.sourceUrl, item.repo, item.prNumber);
  const prUrl = safePrUrl(item.prUrl, item.repo, item.prNumber);
  const pr = `${esc(item.repo)} #${item.prNumber}`;
  const github = item.channelName === 'GitHub requested reviews';
  const created = item.channelName === 'Helmsman created PRs';
  const parentRunId = created ? /^\/runs\?run=([a-z\d_-]{1,128})$/i.exec(item.sourceUrl)?.[1] : null;
  const routing = [item.complexity ? `${item.complexity} complexity` : null, item.model, item.effort ? `${item.effort} effort` : null].filter(Boolean).join(' · ');
  return `<li class="slack-notification${item.readAt ? '' : ' is-unread'}" data-notification-id="${esc(item.id)}">
    <div class="slack-notification-top"><strong class="slack-status slack-status--${item.status}">${labels()[item.status]}</strong><time datetime="${esc(item.createdAt)}" title="${esc(new Date(item.createdAt).toLocaleString())}">${esc(formatRelativeTime(item.createdAt, now))}</time></div>
    <div class="slack-pr">${prUrl ? `<a href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">${pr}</a>` : pr}</div>
    <div class="slack-author">${created ? `Helmsman ${term('review').toLowerCase()} · newly opened ${term('pr')}` : github ? `GitHub ${term('review').toLowerCase()} request · ${esc(item.author || 'Unknown author')}` : `${esc(item.author || 'Someone')} posted in #${esc(item.channelName.replace(/^#/, ''))}`}</div>
    ${routing ? `<div class="slack-routing" aria-label="${term('review')} model selection">${esc(routing)}</div>` : ''}
    ${item.error ? `<p class="slack-error">${esc(item.error)}</p>` : ''}
    <div class="slack-notification-actions">
      ${item.runId && (item.status === 'launched' || item.status === 'failed') ? `<a class="app-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, run: item.runId }))}">View ${term('run').toLowerCase()}</a>` : ''}
      ${parentRunId ? `<a class="app-link" href="${esc(routeHref({ view: 'runs', repo: selectedRepo, run: parentRunId }))}">Original ${term('run').toLowerCase()}</a>` : ''}
      ${source ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${slackSource ? 'Slack message' : 'GitHub request'}</a>` : ''}
      ${item.readAt ? '<span class="slack-read">Read</span>' : `<button type="button" data-slack-read="${esc(item.id)}">Mark read</button>`}
    </div>
  </li>`;
}

function renderHealth(health: SlackHealth, source: string, now: Date): string {
  const status = health.status === 'healthy' ? `Scanning every ${Math.round(health.intervalMs / 60_000)} min`
    : health.status === 'scanning' ? 'Scanning now' : health.status === 'disabled' ? 'Reader disabled'
    : health.status === 'partial' ? 'Scan incomplete' : 'Reader unavailable';
  return `<div class="slack-health" role="status"><strong>${esc(source)}</strong><span>${esc(status)}</span>${health.lastSuccessAt ? `<span>Last scanned ${esc(formatRelativeTime(health.lastSuccessAt, now))}</span>` : ''}${health.error ? `<span class="slack-error">${esc(health.error)}</span>` : ''}</div>`;
}

export function renderSlack(state: SlackState, open: boolean, error: string | null = null, now = new Date(), selectedRepo: string | null = null): string {
  const notifications = state.notifications.filter(item => item && (!selectedRepo || item.repo?.toLowerCase() === selectedRepo.toLowerCase()));
  const unread = notifications.filter(item => !item.readAt).length;
  const channelName = state.health.channelName?.replace(/^#/, '').trim() ?? '';
  return `<button type="button" class="slack-toggle${unread ? ' has-unread' : ''}" data-slack-toggle aria-expanded="${open}" aria-controls="slack-notifications" aria-label="Notifications, ${unread} unread">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 8a5 5 0 0 1 10 0v4l2 3H3l2-3zM8 17h4"/></svg>${unread ? `<span class="slack-count" aria-hidden="true">${unread}</span>` : ''}
  </button>
  <section id="slack-notifications" class="slack-popover" aria-label="Automatic ${term('review').toLowerCase()} notifications"${open ? '' : ' hidden'}>
    <div class="slack-popover-head"><h2>Automatic ${term('reviews').toLowerCase()}</h2><button type="button" data-slack-close aria-label="Close notifications">×</button></div>
    ${renderHealth(state.health, channelName ? `Slack #${channelName}` : 'Slack', now)}
    ${state.githubHealth ? renderHealth(state.githubHealth, `GitHub requested ${term('reviews').toLowerCase()}`, now) : ''}
    ${error ? `<p class="slack-action-error" role="alert">${esc(error)}</p>` : ''}
    ${notifications.length ? `<ol class="slack-notification-list">${notifications.map(item => renderNotification(item, now, selectedRepo)).join('')}</ol>` : `<p class="slack-empty">No ${term('review').toLowerCase()} notifications yet.</p>`}
  </section>`;
}
