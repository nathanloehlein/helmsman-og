import { escapeHtml as esc } from './logic/html';
import './loading.css';

export interface LoadingOptions {
  size?: number;
  labelHidden?: boolean;
}

export function renderLoading(label = 'Loading…', options: LoadingOptions = {}): string {
  const size = typeof options.size === 'number' && Number.isFinite(options.size) && options.size > 0
    ? ` style="--helm-loader-size: ${Math.min(options.size, 512)}px"` : '';
  return `<span class="helm-loader" role="status"${size}><svg class="helm-loader-wheel" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><use href="/helm-emblem.svg#helm-emblem" /></svg><span${options.labelHidden ? ' class="sr-only"' : ''}>${esc(label)}</span></span>`;
}
