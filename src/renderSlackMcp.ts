import type { SlackMcpStatus } from './data/slackMcp';
import { escapeHtml } from './logic/html';

export interface SlackMcpView {
  status: SlackMcpStatus | null;
  pending?: 'status' | 'check' | 'connect' | 'disconnect' | null;
  error?: string | null;
}

export function renderSlackMcp(view: SlackMcpView = { status: null }): string {
  const status = view.status;
  const pending = view.pending;
  let connectionUrl: string | null = null;
  try {
    const callback = new URL(status?.redirectUri ?? '');
    if (callback.protocol === 'https:' && !callback.username && !callback.password) connectionUrl = `${callback.origin}/config`;
  } catch {}
  const message = pending === 'connect' ? 'Opening Slack authorization…'
    : pending === 'disconnect' ? 'Disconnecting Slack…'
      : pending ? 'Checking Slack connection…' : status?.message ?? 'Slack connection has not been checked.';
  return `<div class="config-warning" data-slack-mcp>
    <p role="status">${escapeHtml(message)}</p>
    ${view.error ? `<p role="alert">${escapeHtml(view.error)}</p>` : ''}
    ${status?.status === 'setup-required' ? '<p>Configure an approved Slack OAuth app with its client ID, client secret, and registered HTTPS callback URL, then connect your Slack account.</p>' : ''}
    ${connectionUrl ? `<p>Connect from <a href="${escapeHtml(connectionUrl)}">${escapeHtml(connectionUrl)}</a> so Slack can return to this Helmsman instance.</p>` : ''}
    ${status?.connected ? `<p>Workspace: ${escapeHtml(status.teamId ?? 'Unknown')} · User: ${escapeHtml(status.userId ?? 'Unknown')}</p>` : ''}
    <div class="slack-mcp-actions"><button type="button" data-slack-mcp-action="connect"${pending || !status?.configured ? ' disabled' : ''}>${status?.connected ? 'Reconnect Slack' : 'Connect Slack'}</button>
    <button type="button" data-slack-mcp-action="check"${pending ? ' disabled' : ''}>Check connection</button>
    <button type="button" data-slack-mcp-action="disconnect"${pending || !status?.userId ? ' disabled' : ''}>Disconnect</button></div>
  </div>`;
}
