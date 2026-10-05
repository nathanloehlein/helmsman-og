import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyTheme,
  DEFAULT_THEME_ID,
  getTheme,
  loadThemeId,
  saveThemeId,
  THEMES,
  REQUIRED_VAR_KEYS,
  type Theme,
} from './themes';

const stylesheet = readFileSync('src/style.css', 'utf8');
const rootStyles = stylesheet.match(/:root\s*\{([^}]+)\}/)?.[1];
if (!rootStyles) throw new Error('Missing fallback theme styles');
const fallbackVars = Object.fromEntries(Array.from(rootStyles.matchAll(/(--[\w-]+):\s*([^;]+);/g), match => [match[1], match[2]?.trim()]));
const resolvedFallbackVars = Object.fromEntries(Object.entries(fallbackVars).map(([key, value]) => {
  const reference = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return [key, reference ? fallbackVars[reference] ?? '' : value ?? ''];
}));
const themePalettes = THEMES.map(theme => ({ ...theme, vars: theme.id === 'amber' ? resolvedFallbackVars : theme.vars }));

function luminance(hex: string): number {
  const channels: number[] = (hex.match(/[a-f\d]{2}/gi) ?? []).map((channel) => {
    const value: number = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function compositeBorder(border: string, background: string): string {
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(border);
  if (!rgba || !/^#[a-f\d]{6}$/i.test(background)) {
    throw new Error(`Unsupported border/background: ${border} / ${background}`);
  }
  const alpha = Number(rgba[4]);
  return '#' + [0, 1, 2].map(index => {
    const foregroundChannel = Number(rgba[index + 1]);
    const backgroundChannel = parseInt(background.slice(1 + index * 2, 3 + index * 2), 16);
    return Math.round(foregroundChannel * alpha + backgroundChannel * (1 - alpha)).toString(16).padStart(2, '0');
  }).join('');
}

describe('THEMES data', () => {
  it('has unique ids', () => {
    const ids: string[] = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists Quarterdeck first as the default theme', () => {
    expect(THEMES[0]?.id).toBe('quarterdeck');
    expect(THEMES[0]?.id).toBe(DEFAULT_THEME_ID);
  });

  it('has at least 11 presets', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(11);
  });

  it('getTheme resolves the default theme id', () => {
    expect(getTheme(DEFAULT_THEME_ID)?.id).toBe(DEFAULT_THEME_ID);
  });

  it('getTheme returns undefined for an unknown id', () => {
    expect(getTheme('does-not-exist')).toBeUndefined();
  });

  it('GUARD: every non-amber theme defines every required role variable', () => {
    const nonAmber: Theme[] = THEMES.filter((t) => t.id !== 'amber');
    expect(nonAmber.length).toBeGreaterThan(0);
    for (const theme of nonAmber) {
      const keys: string[] = Object.keys(theme.vars).sort();
      expect(keys, `theme "${theme.id}" var keys`).toEqual([...REQUIRED_VAR_KEYS].sort());
    }
  });

  it('EXEMPTION: amber is exempt from the role guard because it applies by clearing overrides', () => {
    const amber: Theme | undefined = getTheme('amber');
    expect(amber).toBeDefined();
    expect(Object.keys(amber!.vars).length).toBe(0);
  });

  it('uses neutral dividers independently of the action accent', () => {
    const dracula = getTheme('dracula');
    expect(dracula?.vars['--line']).toBe('rgba(184, 184, 192, 0.32)');
    expect(dracula?.vars['--line-strong']).toBe('rgba(184, 184, 192, 0.72)');
    expect(dracula?.vars['--line-faint']).toBe('rgba(184, 184, 192, 0.18)');
    expect(dracula?.vars['--secondary']).not.toBe(dracula?.vars['--accent']);
  });

  it('sets --accent-plate equal to --accent for every non-amber theme', () => {
    for (const theme of THEMES.filter((t) => t.id !== 'amber')) {
      expect(theme.vars['--accent-plate']).toBe(theme.vars['--accent']);
    }
  });

  it('includes both dark and light modes', () => {
    const modes: Set<string> = new Set(THEMES.map((t) => t.mode));
    expect(modes.has('dark')).toBe(true);
    expect(modes.has('light')).toBe(true);
  });

  it.each(themePalettes)(
    '$id keeps control outlines distinguishable from each control surface',
    theme => {
      const border = theme.vars['--line-strong'] ?? '';
      for (const surface of ['--panel', '--panel-2', '--panel-hi']) {
        const background = theme.vars[surface] ?? '';
        expect(contrast(compositeBorder(border, background), background), `${theme.id}: control outline on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(themePalettes)(
    '$id separates editable fields while keeping their text and boundaries legible',
    theme => {
      const background = theme.vars['--control-bg'] ?? '';
      const border = theme.vars['--control-border'] ?? '';
      expect(background).toMatch(/^#[a-f\d]{6}$/i);
      expect(border).toMatch(/^#[a-f\d]{6}$/i);
      for (const foreground of ['--text', '--text-dim', '--text-faint']) {
        expect(contrast(theme.vars[foreground] ?? '', background), `${theme.id}: ${foreground} in input`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of ['--panel', '--panel-2']) {
        expect(contrast(background, theme.vars[surface] ?? ''), `${theme.id}: input fill on ${surface}`).toBeGreaterThanOrEqual(1.1);
      }
      for (const surface of ['--panel', '--panel-2', '--panel-hi']) {
        expect(contrast(border, theme.vars[surface] ?? ''), `${theme.id}: input boundary on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(border, background), `${theme.id}: input boundary against fill`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.vars['--accent'] ?? '', background), `${theme.id}: input focus against fill`).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(themePalettes)(
    '$id keeps labels readable on filled actions and success statuses',
    theme => {
      for (const [foreground, background] of [['--on-accent', '--accent'], ['--on-good', '--good']] as const) {
        expect(contrast(theme.vars[foreground] ?? '', theme.vars[background] ?? ''), `${theme.id}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(themePalettes)(
    '$id separates its page from its main panel surface',
    theme => {
      expect(contrast(theme.vars['--bg'] ?? '', theme.vars['--panel'] ?? ''), `${theme.id}: page versus panel`).toBeGreaterThanOrEqual(1.05);
    },
  );

  it.each(themePalettes)(
    '$id keeps text, accents, and status colors readable across its surfaces',
    (theme) => {
      const { id } = theme;
      const foregrounds: string[] = ['--text', '--text-dim', '--text-faint', '--accent', '--secondary', '--bad', '--good', '--review', '--queued'];
      const backgrounds: string[] = ['--bg', '--gutter', '--panel', '--panel-2', '--panel-hi'];
      for (const foreground of foregrounds) {
        for (const background of backgrounds) {
          const foregroundHex: string = theme.vars[foreground] ?? '';
          const backgroundHex: string = theme.vars[background] ?? '';
          expect(foregroundHex).toMatch(/^#[a-f\d]{6}$/i);
          expect(backgroundHex).toMatch(/^#[a-f\d]{6}$/i);
          const lighter: number = Math.max(luminance(foregroundHex), luminance(backgroundHex));
          const darker: number = Math.min(luminance(foregroundHex), luminance(backgroundHex));
          expect((lighter + 0.05) / (darker + 0.05), `${id}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});

describe('loadThemeId / saveThemeId', () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      getItem: (key: string): string | null => store[key] ?? null,
      setItem: (key: string, value: string): void => {
        store[key] = value;
      },
      removeItem: (key: string): void => {
        delete store[key];
      },
      clear: (): void => {
        store = {};
      },
      key: (): string | null => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    store = {};
  });

  it('returns the default theme id when nothing is stored', () => {
    expect(loadThemeId()).toBe(DEFAULT_THEME_ID);
  });

  it('returns the default theme id when the stored value is unknown', () => {
    store['cmux.theme'] = 'not-a-real-theme';
    expect(loadThemeId()).toBe(DEFAULT_THEME_ID);
  });

  it('returns a valid stored theme id', () => {
    store['cmux.theme'] = 'nord';
    expect(loadThemeId()).toBe('nord');
  });

  it('saveThemeId persists the id for loadThemeId to read back', () => {
    saveThemeId('dracula');
    expect(store['cmux.theme']).toBe('dracula');
    expect(loadThemeId()).toBe('dracula');
  });
});

describe('applyTheme (DOM)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
  });

  it('sets inline vars, dataset.theme, and colorScheme for a non-amber theme', () => {
    applyTheme('dracula');
    const root: HTMLElement = document.documentElement;
    expect(root.style.getPropertyValue('--accent')).toBe(getTheme('dracula')?.vars['--accent']);
    expect(root.dataset.theme).toBe('dracula');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('sets colorScheme to light for a light theme', () => {
    applyTheme('github-light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('github-light');
  });

  it('clears all inline role vars and sets dataset.theme=amber when applying amber', () => {
    applyTheme('dracula');
    applyTheme('amber');
    const root: HTMLElement = document.documentElement;
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(root.style.getPropertyValue('--bg')).toBe('');
    expect(root.dataset.theme).toBe('amber');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('falls back to the default theme for an unknown id', () => {
    applyTheme('dracula');
    applyTheme('nonsense-theme-id');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(getTheme(DEFAULT_THEME_ID)?.vars['--accent']);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });
});
