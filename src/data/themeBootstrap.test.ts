import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeBootstrapScript } from '../../build-theme';
import { AMBER_BACKGROUND, applyTheme, DEFAULT_THEME_ID, getTheme } from './themes';

describe('initial theme bootstrap', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color" content="#081721">';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '';
  });

  function bootstrap(stored: string | null): void {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'cmux.theme' ? stored : null });
    new Function(themeBootstrapScript())();
  }

  it.each(['github-light', 'solarized-light', 'nord', 'amber'])('restores %s before the application runs', (id) => {
    bootstrap(id);
    const theme = getTheme(id);
    expect(document.documentElement.dataset.theme).toBe(id);
    expect(document.documentElement.style.colorScheme).toBe(theme?.mode);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(theme?.vars['--bg'] ?? '');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(theme?.vars['--bg'] ?? AMBER_BACKGROUND);
  });

  it.each([null, 'removed-theme'])('uses the default for unavailable preference %s', (stored) => {
    bootstrap(stored);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('uses the default when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('Access denied', 'SecurityError'); } });
    expect(() => new Function(themeBootstrapScript())()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('keeps browser chrome aligned when changing themes after startup', () => {
    bootstrap('github-light');
    applyTheme('nord');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(getTheme('nord')?.vars['--bg']);
    applyTheme('amber');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(AMBER_BACKGROUND);
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
  });
});
