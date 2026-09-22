import type { FirefoxBridgeStatus } from './data/firefoxBridge';
import { escapeHtml } from './logic/html';

export interface FirefoxBridgeView {
  status: FirefoxBridgeStatus | null;
  pending?: 'check' | 'start' | null;
  error?: string | null;
}

export function renderFirefoxBridge(view: FirefoxBridgeView = { status: null }): string {
  const status = view.status;
  return `<div class="config-warning" data-firefox-bridge>
    <p role="status">${escapeHtml(view.pending === 'start' ? 'Starting Firefox bridge…' : view.pending === 'check' ? 'Checking Firefox bridge…' : status?.message ?? 'Firefox bridge status has not been checked.')}</p>
    ${view.error ? `<p role="alert">${escapeHtml(view.error)}</p>` : ''}
    <button type="button" data-firefox-bridge-check${view.pending ? ' disabled' : ''}>Check status</button>
    <button type="button" data-firefox-bridge-start${view.pending || !status?.canStart || view.error ? ' disabled' : ''}>Start bridge</button>
  </div>`;
}
