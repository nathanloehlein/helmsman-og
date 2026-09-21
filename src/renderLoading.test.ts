import { describe, expect, it } from 'vitest';
import { renderLoading } from './renderLoading';
import { renderConfigView, renderPrView } from './render';
import { DEFAULT_THEME_ID } from './data/themes';

function mount(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('Helmsman loading indicator', () => {
  it('reuses the shared emblem with an accessible status and escaped label', () => {
    const root = mount(renderLoading('Loading <script>alert(1)</script>…', { size: 40 }));
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Loading <script>alert(1)</script>…');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('use')?.getAttribute('href')).toBe('/helm-emblem.svg#helm-emblem');
    expect(root.querySelector<HTMLElement>('.helm-loader')?.style.getPropertyValue('--helm-loader-size')).toBe('40px');
  });
  it('supports an icon with a screen-reader label and safely defaults invalid sizes', () => {
    const root = mount(renderLoading('Loading results', { size: Number.NaN, labelHidden: true }));
    expect(root.querySelector('.sr-only')?.textContent).toBe('Loading results');
    expect(root.querySelector('.helm-loader')?.hasAttribute('style')).toBe(false);
  });
  it('appears for pending configuration and PR details and is absent for errors', () => {
    const opts = { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID };
    expect(mount(renderConfigView({ config: {}, overridden: [] }, { ...opts, loading: true, unavailable: true })).querySelector('.helm-loader')).not.toBeNull();
    expect(mount(renderConfigView({ config: {}, overridden: [] }, { ...opts, error: 'Unavailable', unavailable: true })).querySelector('.helm-loader')).toBeNull();
    expect(mount(renderPrView({ repo: 'org/app', number: 1, loading: true, pr: null, diff: null }, opts)).querySelector('.helm-loader')).not.toBeNull();
  });
});
