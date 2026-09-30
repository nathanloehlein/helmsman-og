import type { Plugin } from 'vite';
import {
  AMBER_BACKGROUND,
  applyThemeToDocument,
  DEFAULT_THEME_ID,
  REQUIRED_VAR_KEYS,
  THEMES,
  THEME_STORAGE_KEY,
} from './src/data/themes';

export function themeBootstrapScript(): string {
  const serialize = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `(() => {
    const themes = ${serialize(THEMES)};
    let id = ${serialize(DEFAULT_THEME_ID)};
    try { id = localStorage.getItem(${serialize(THEME_STORAGE_KEY)}) || id; } catch {}
    const theme = themes.find(theme => theme.id === id) || themes.find(theme => theme.id === ${serialize(DEFAULT_THEME_ID)});
    (${applyThemeToDocument.toString()})(theme, ${serialize(REQUIRED_VAR_KEYS)}, ${serialize(AMBER_BACKGROUND)});
  })();`;
}

export function themeBootstrapPlugin(): Plugin {
  return {
    name: 'helmsman-theme-bootstrap',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', children: themeBootstrapScript(), injectTo: 'head' }],
    },
  };
}
