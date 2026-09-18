export type ThemeMode = 'dark' | 'light';

export interface Theme {
  id: string;
  label: string;
  mode: ThemeMode;
  vars: Record<string, string>;
}

export const DEFAULT_THEME_ID = 'quarterdeck';

const STORAGE_KEY = 'cmux.theme';

export const REQUIRED_VAR_KEYS: readonly string[] = [
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

interface ThemeAnchors {
  id: string;
  label: string;
  mode: ThemeMode;
  bg: string;
  gutter: string;
  panel: string;
  panel2: string;
  panelHi: string;
  accent: string;
  text: string;
  textDim: string;
  textFaint: string;
  bad: string;
  good: string;
  review: string;
  queued: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean: string = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c: number): string => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function deriveVars(anchors: ThemeAnchors): Record<string, string> {
  return {
    '--bg': anchors.bg,
    '--gutter': anchors.gutter,
    '--panel': anchors.panel,
    '--panel-2': anchors.panel2,
    '--panel-hi': anchors.panelHi,
    '--line': rgbaFromHex(anchors.accent, 0.16),
    '--line-strong': rgbaFromHex(anchors.accent, 0.34),
    '--line-faint': rgbaFromHex(anchors.accent, 0.08),
    '--accent': anchors.accent,
    '--accent-bright': lighten(anchors.accent, 0.15),
    '--accent-dim': rgbaFromHex(anchors.accent, 0.55),
    '--accent-plate': anchors.accent,
    '--text': anchors.text,
    '--text-dim': anchors.textDim,
    '--text-faint': anchors.textFaint,
    '--bad': anchors.bad,
    '--good': anchors.good,
    '--review': anchors.review,
    '--queued': anchors.queued,
  };
}

const THEME_ANCHORS: ThemeAnchors[] = [
  {
    id: 'quarterdeck', label: 'Quarterdeck', mode: 'dark',
    bg: '#081721', gutter: '#061019', panel: '#102938', panel2: '#2d241e', panelHi: '#1b3544',
    accent: '#dfb778', text: '#f3ecdc', textDim: '#c9c6b6', textFaint: '#b7b6a5',
    bad: '#f59986', good: '#92cdb2', review: '#8ecae6', queued: '#e6c785',
  },
  {
    id: 'abyss', label: 'Abyss', mode: 'dark',
    bg: '#06131f', gutter: '#030d17', panel: '#0b1c2b', panel2: '#102738', panelHi: '#183449',
    accent: '#55d8ee', text: '#e5f5fc', textDim: '#b1cedd', textFaint: '#8fabbc',
    bad: '#ff8c9b', good: '#76ddb0', review: '#80bfff', queued: '#e4c582',
  },
  {
    id: 'forest', label: 'Forest', mode: 'dark',
    bg: '#0c1712', gutter: '#07100c', panel: '#12231b', panel2: '#1b2f24', panelHi: '#263c2e',
    accent: '#9fdda2', text: '#e9f3df', textDim: '#c0d2b5', textFaint: '#a3b79a',
    bad: '#f59b8e', good: '#a6e7b2', review: '#95cedd', queued: '#e2ca87',
  },
  {
    id: 'ember', label: 'Ember', mode: 'dark',
    bg: '#1c100d', gutter: '#130a08', panel: '#281813', panel2: '#36221a', panelHi: '#442d23',
    accent: '#ff9a70', text: '#fff0df', textDim: '#ddbfaa', textFaint: '#c2a28e',
    bad: '#ff96a4', good: '#b6d68b', review: '#90cddb', queued: '#f2ca7d',
  },
  {
    id: 'aubergine', label: 'Aubergine', mode: 'dark',
    bg: '#1b0e1b', gutter: '#120912', panel: '#281627', panel2: '#362035', panelHi: '#452b43',
    accent: '#f1a3cb', text: '#fbeaf6', textDim: '#d9b8d1', textFaint: '#be9db7',
    bad: '#ff9b93', good: '#a7d9b4', review: '#adc9fc', queued: '#e7cf94',
  },
  {
    id: 'graphite', label: 'Graphite', mode: 'dark',
    bg: '#101010', gutter: '#080808', panel: '#1a1a1a', panel2: '#252525', panelHi: '#333333',
    accent: '#dedede', text: '#f5f5f5', textDim: '#c8c8c8', textFaint: '#a6a6a6',
    bad: '#ff9696', good: '#a4d5ad', review: '#a9c9f5', queued: '#e5c691',
  },
  {
    id: 'phosphor', label: 'Phosphor', mode: 'dark',
    bg: '#030a04', gutter: '#010502', panel: '#09140b', panel2: '#102014', panelHi: '#19301d',
    accent: '#8cfb69', text: '#d8ffd0', textDim: '#add89d', textFaint: '#8fb782',
    bad: '#ff9980', good: '#a8f887', review: '#87dfd2', queued: '#dbe885',
  },
  {
    id: 'dracula', label: 'Dracula', mode: 'dark',
    bg: '#282a36', gutter: '#21222c', panel: '#282a36', panel2: '#343746', panelHi: '#424450',
    accent: '#bd93f9', text: '#f8f8f2', textDim: '#b8b8c0', textFaint: '#6272a4',
    bad: '#ff5555', good: '#50fa7b', review: '#8be9fd', queued: '#ffb86c',
  },
  {
    id: 'nord', label: 'Nord', mode: 'dark',
    bg: '#2e3440', gutter: '#272c36', panel: '#2e3440', panel2: '#3b4252', panelHi: '#434c5e',
    accent: '#88c0d0', text: '#eceff4', textDim: '#d8dee9', textFaint: '#7b869c',
    bad: '#bf616a', good: '#a3be8c', review: '#81a1c1', queued: '#b48ead',
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', mode: 'dark',
    bg: '#1a1b26', gutter: '#16161e', panel: '#1a1b26', panel2: '#24283b', panelHi: '#2f334d',
    accent: '#7aa2f7', text: '#c0caf5', textDim: '#9aa5ce', textFaint: '#565f89',
    bad: '#f7768e', good: '#9ece6a', review: '#7dcfff', queued: '#bb9af7',
  },
  {
    id: 'one-dark', label: 'One Dark', mode: 'dark',
    bg: '#282c34', gutter: '#21252b', panel: '#282c34', panel2: '#2c313a', panelHi: '#3a3f4b',
    accent: '#61afef', text: '#abb2bf', textDim: '#9198a4', textFaint: '#5c6370',
    bad: '#e06c75', good: '#98c379', review: '#56b6c2', queued: '#c678dd',
  },
  {
    id: 'gruvbox-dark', label: 'Gruvbox Dark', mode: 'dark',
    bg: '#282828', gutter: '#1d2021', panel: '#282828', panel2: '#3c3836', panelHi: '#504945',
    accent: '#fabd2f', text: '#ebdbb2', textDim: '#d5c4a1', textFaint: '#928374',
    bad: '#fb4934', good: '#b8bb26', review: '#83a598', queued: '#d3869b',
  },
  {
    id: 'monokai', label: 'Monokai', mode: 'dark',
    bg: '#272822', gutter: '#1e1f1c', panel: '#272822', panel2: '#3e3d32', panelHi: '#49483e',
    accent: '#f92672', text: '#f8f8f2', textDim: '#cfcfc2', textFaint: '#75715e',
    bad: '#ff6188', good: '#a6e22e', review: '#66d9ef', queued: '#ae81ff',
  },
  {
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha', mode: 'dark',
    bg: '#1e1e2e', gutter: '#181825', panel: '#1e1e2e', panel2: '#313244', panelHi: '#45475a',
    accent: '#cba6f7', text: '#cdd6f4', textDim: '#a6adc8', textFaint: '#6c7086',
    bad: '#f38ba8', good: '#a6e3a1', review: '#89dceb', queued: '#f5c2e7',
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', mode: 'dark',
    bg: '#002b36', gutter: '#00252e', panel: '#073642', panel2: '#0a4351', panelHi: '#0e4f5f',
    accent: '#268bd2', text: '#93a1a1', textDim: '#839496', textFaint: '#586e75',
    bad: '#dc322f', good: '#859900', review: '#2aa198', queued: '#6c71c4',
  },
  {
    id: 'solarized-light', label: 'Solarized Light', mode: 'light',
    bg: '#fdf6e3', gutter: '#eee8d5', panel: '#fdf6e3', panel2: '#eee8d5', panelHi: '#e3ddc8',
    accent: '#268bd2', text: '#586e75', textDim: '#657b83', textFaint: '#93a1a1',
    bad: '#dc322f', good: '#859900', review: '#2aa198', queued: '#6c71c4',
  },
  {
    id: 'github-light', label: 'GitHub Light', mode: 'light',
    bg: '#ffffff', gutter: '#f6f8fa', panel: '#ffffff', panel2: '#f6f8fa', panelHi: '#eaeef2',
    accent: '#0969da', text: '#1f2328', textDim: '#656d76', textFaint: '#8c959f',
    bad: '#cf222e', good: '#1a7f37', review: '#0550ae', queued: '#8250df',
  },
];

export const THEMES: Theme[] = [
  ...THEME_ANCHORS.map((anchors): Theme => ({
    id: anchors.id,
    label: anchors.label,
    mode: anchors.mode,
    vars: deriveVars(anchors),
  })),
  { id: 'amber', label: 'Amber', mode: 'dark', vars: {} },
];

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((theme) => theme.id === id);
}

export function applyTheme(id: string): void {
  if (typeof document === 'undefined') return;
  const root: HTMLElement = document.documentElement;
  const theme: Theme = getTheme(id) ?? getTheme(DEFAULT_THEME_ID)!;

  if (theme.id === 'amber') {
    for (const key of REQUIRED_VAR_KEYS) root.style.removeProperty(key);
    root.dataset.theme = theme.id;
    root.style.colorScheme = 'dark';
    return;
  }

  for (const key of REQUIRED_VAR_KEYS) {
    const value: string | undefined = theme.vars[key];
    if (value) root.style.setProperty(key, value);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
}

export function loadThemeId(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID;
    const stored: string | null = localStorage.getItem(STORAGE_KEY);
    if (stored && getTheme(stored)) return stored;
    return DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function saveThemeId(id: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    return;
  }
}
