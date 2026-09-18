import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  DEFAULT_THEME_ID,
  getTheme,
  loadThemeId,
  saveThemeId,
  THEMES,
  type Theme,
} from './themes';

const REQUIRED_VAR_KEYS: readonly string[] = [
  '--bg',
  '--gutter',
  '--panel',
  '--panel-2',
  '--panel-hi',
  '--line',
  '--line-strong',
  '--line-faint',
  '--accent',
  '--accent-bright',
  '--accent-dim',
  '--accent-plate',
  '--text',
  '--text-dim',
  '--text-faint',
  '--bad',
  '--good',
  '--review',
  '--queued',
];

function luminance(hex: string): number {
  const channels: number[] = (hex.match(/[a-f\d]{2}/gi) ?? []).map((channel) => {
    const value: number = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

  it('GUARD: every non-amber theme defines exactly the 19 required role vars', () => {
    const nonAmber: Theme[] = THEMES.filter((t) => t.id !== 'amber');
    expect(nonAmber.length).toBeGreaterThan(0);
    for (const theme of nonAmber) {
      const keys: string[] = Object.keys(theme.vars).sort();
      expect(keys, `theme "${theme.id}" var keys`).toEqual([...REQUIRED_VAR_KEYS].sort());
    }
  });

  it('EXEMPTION: amber is exempt from the 19-key guard because it applies by clearing overrides', () => {
    const amber: Theme | undefined = getTheme('amber');
    expect(amber).toBeDefined();
    expect(Object.keys(amber!.vars).length).toBe(0);
  });

  it('derives --line/--line-strong/--line-faint/--accent-dim as rgba of the theme accent (dracula)', () => {
    const dracula: Theme | undefined = getTheme('dracula');
    expect(dracula).toBeDefined();
    expect(dracula!.vars['--accent']).toBe('#bd93f9');
    expect(dracula!.vars['--line']).toContain('189, 147, 249');
    expect(dracula!.vars['--line-strong']).toContain('189, 147, 249');
    expect(dracula!.vars['--line-faint']).toContain('189, 147, 249');
    expect(dracula!.vars['--accent-dim']).toContain('189, 147, 249');
    expect(dracula!.vars['--line']).toContain('0.16');
    expect(dracula!.vars['--line-strong']).toContain('0.34');
    expect(dracula!.vars['--line-faint']).toContain('0.08');
    expect(dracula!.vars['--accent-dim']).toContain('0.55');
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

  it.each(['quarterdeck', 'abyss', 'forest', 'ember', 'aubergine', 'graphite', 'phosphor'])(
    '%s keeps text, accents, and status colors readable across its dark surfaces',
    (id) => {
      const theme: Theme | undefined = getTheme(id);
      expect(theme?.mode).toBe('dark');
      if (!theme) throw new Error(`Missing theme: ${id}`);
      const foregrounds: string[] = ['--text', '--text-dim', '--text-faint', '--accent', '--bad', '--good', '--review', '--queued'];
      const backgrounds: string[] = ['--bg', '--gutter', '--panel', '--panel-2', '--panel-hi'];
      for (const foreground of foregrounds) {
        for (const background of backgrounds) {
          const foregroundHex: string = theme.vars[foreground] ?? '';
          const backgroundHex: string = theme.vars[background] ?? '';
          expect(foregroundHex).toMatch(/^#[a-f\d]{6}$/i);
          expect(backgroundHex).toMatch(/^#[a-f\d]{6}$/i);
          const lighter: number = luminance(foregroundHex);
          const darker: number = luminance(backgroundHex);
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
    expect(root.style.getPropertyValue('--accent')).toBe('#bd93f9');
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
