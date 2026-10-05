export type ThemeMode = 'dark' | 'light';

export interface Theme {
  id: string;
  label: string;
  mode: ThemeMode;
  vars: Record<string, string>;
}

export const DEFAULT_THEME_ID = 'quarterdeck';

export const THEME_STORAGE_KEY = 'cmux.theme';
export const AMBER_BACKGROUND = '#08090c';

export const REQUIRED_VAR_KEYS: readonly string[] = [
  '--bg',
  '--gutter',
  '--panel',
  '--panel-2',
  '--panel-hi',
  '--control-bg',
  '--control-border',
  '--line',
  '--line-strong',
  '--line-faint',
  '--secondary',
  '--on-accent',
  '--on-good',
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
  secondary: string;
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

function mixHex(hex: string, target: number, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c: number): string => Math.round(c + (target - c) * amount).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function deriveVars(anchors: ThemeAnchors): Record<string, string> {
  return {
    '--bg': anchors.bg,
    '--gutter': anchors.gutter,
    '--panel': anchors.panel,
    '--panel-2': anchors.panel2,
    '--panel-hi': anchors.panelHi,
    '--control-bg': mixHex(anchors.panel, 0, anchors.mode === 'light' ? 0.1 : 0.65),
    '--control-border': mixHex(anchors.textDim, 0, anchors.mode === 'light' ? 0.05 : 0.18),
    '--line': rgbaFromHex(anchors.textDim, 0.32),
    '--line-strong': rgbaFromHex(anchors.textDim, anchors.mode === 'light' ? 0.76 : 0.72),
    '--line-faint': rgbaFromHex(anchors.textDim, 0.18),
    '--secondary': anchors.secondary,
    '--on-accent': anchors.mode === 'light' ? '#ffffff' : '#08090c',
    '--on-good': anchors.mode === 'light' ? '#ffffff' : '#08090c',
    '--accent': anchors.accent,
    '--accent-bright': mixHex(anchors.accent, anchors.mode === 'light' ? 0 : 255, 0.15),
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
    bg: '#0c141e', gutter: '#080e16', panel: '#192633', panel2: '#223544', panelHi: '#2b3e4e',
    accent: '#efb86d', secondary: '#89cfca', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#f59986', good: '#92cdb2', review: '#8ecae6', queued: '#e6c785',
  },
  {
    id: 'abyss', label: 'Abyss', mode: 'dark',
    bg: '#0f1220', gutter: '#090c16', panel: '#1b2035', panel2: '#282e46', panelHi: '#32394f',
    accent: '#80dbed', secondary: '#f2a6b6', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#ff8c9b', good: '#76ddb0', review: '#80bfff', queued: '#e4c582',
  },
  {
    id: 'forest', label: 'Forest', mode: 'dark',
    bg: '#171e1c', gutter: '#101613', panel: '#242e29', panel2: '#313c34', panelHi: '#3b463d',
    accent: '#e5c07b', secondary: '#9bd1be', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#adb3b4',
    bad: '#f59b8e', good: '#a6e7b2', review: '#95cedd', queued: '#e2ca87',
  },
  {
    id: 'ember', label: 'Ember', mode: 'dark',
    bg: '#1c1918', gutter: '#121110', panel: '#2b2725', panel2: '#3b3430', panelHi: '#453d37',
    accent: '#f4a77f', secondary: '#afd0a0', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#ff96a4', good: '#b6d68b', review: '#90cddb', queued: '#f2ca7d',
  },
  {
    id: 'aubergine', label: 'Aubergine', mode: 'dark',
    bg: '#191724', gutter: '#12101a', panel: '#262135', panel2: '#342c43', panelHi: '#40354d',
    accent: '#ebbcba', secondary: '#9ccfd8', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#ff9b93', good: '#a7d9b4', review: '#adc9fc', queued: '#e7cf94',
  },
  {
    id: 'graphite', label: 'Graphite', mode: 'dark',
    bg: '#111315', gutter: '#090b0d', panel: '#232629', panel2: '#303539', panelHi: '#3b4146',
    accent: '#ffbc85', secondary: '#9cc9ef', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#ff9696', good: '#a4d5ad', review: '#a9c9f5', queued: '#e5c691',
  },
  {
    id: 'phosphor', label: 'Phosphor', mode: 'dark',
    bg: '#111716', gutter: '#0a100f', panel: '#202a27', panel2: '#303b35', panelHi: '#3a453e',
    accent: '#bbdf83', secondary: '#c2b2f0', text: '#f1eee8', textDim: '#c4c6c5', textFaint: '#acb2b3',
    bad: '#ff9980', good: '#a8f887', review: '#87dfd2', queued: '#dbe885',
  },
  {
    id: 'dracula', label: 'Dracula', mode: 'dark',
    bg: '#191a23', gutter: '#12131b', panel: '#282a36', panel2: '#343746', panelHi: '#3d404f',
    accent: '#c29cf9', secondary: '#ffb86c', text: '#f8f8f2', textDim: '#b8b8c0', textFaint: '#a4adca',
    bad: '#ff8d8d', good: '#50fa7b', review: '#8be9fd', queued: '#ffb86c',
  },
  {
    id: 'nord', label: 'Nord', mode: 'dark',
    bg: '#202630', gutter: '#191e27', panel: '#2e3440', panel2: '#3b4252', panelHi: '#434c5e',
    accent: '#93c6d4', secondary: '#ebcb8b', text: '#eceff4', textDim: '#d8dee9', textFaint: '#b8beca',
    bad: '#e0b2b6', good: '#adc599', review: '#abc0d5', queued: '#cfb7cb',
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', mode: 'dark',
    bg: '#13141e', gutter: '#0d0e16', panel: '#1a1b26', panel2: '#24283b', panelHi: '#2f334d',
    accent: '#7aa2f7', secondary: '#e0af68', text: '#c0caf5', textDim: '#9aa5ce', textFaint: '#989db7',
    bad: '#f7768e', good: '#9ece6a', review: '#7dcfff', queued: '#bb9af7',
  },
  {
    id: 'one-dark', label: 'One Dark', mode: 'dark',
    bg: '#1c2027', gutter: '#15181e', panel: '#282c34', panel2: '#343a45', panelHi: '#3e4551',
    accent: '#77baf1', secondary: '#e5c07b', text: '#e6e8ef', textDim: '#c4c8d0', textFaint: '#b1b4ba',
    bad: '#eb9fa5', good: '#98c379', review: '#6ec0cb', queued: '#d7a0e7',
  },
  {
    id: 'gruvbox-dark', label: 'Gruvbox Dark', mode: 'dark',
    bg: '#1d2021', gutter: '#141617', panel: '#282828', panel2: '#3c3836', panelHi: '#45403c',
    accent: '#fabd2f', secondary: '#8ec07c', text: '#ebdbb2', textDim: '#d5c4a1', textFaint: '#b7ada3',
    bad: '#fd9083', good: '#b8bb26', review: '#98b4aa', queued: '#db9dae',
  },
  {
    id: 'monokai', label: 'Monokai', mode: 'dark',
    bg: '#191a17', gutter: '#11120f', panel: '#272822', panel2: '#36372f', panelHi: '#414238',
    accent: '#ff8ab3', secondary: '#a6e22e', text: '#f8f8f2', textDim: '#cfcfc2', textFaint: '#b2afa5',
    bad: '#ff8ca8', good: '#a6e22e', review: '#66d9ef', queued: '#c09dff',
  },
  {
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha', mode: 'dark',
    bg: '#11111b', gutter: '#0b0b12', panel: '#1e1e2e', panel2: '#313244', panelHi: '#3b3d50',
    accent: '#cba6f7', secondary: '#f5c2e7', text: '#cdd6f4', textDim: '#a6adc8', textFaint: '#a8abb8',
    bad: '#f38ba8', good: '#a6e3a1', review: '#89dceb', queued: '#f5c2e7',
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', mode: 'dark',
    bg: '#00212b', gutter: '#001a22', panel: '#073642', panel2: '#0a404b', panelHi: '#124953',
    accent: '#69b9e8', secondary: '#e3b85f', text: '#e1e7e3', textDim: '#c0cdcd', textFaint: '#a8b4b7',
    bad: '#ee9b99', good: '#abb94f', review: '#6cbeb8', queued: '#aaaddd',
  },
  {
    id: 'solarized-light', label: 'Solarized Light', mode: 'light',
    bg: '#eee8d5', gutter: '#e4ddc8', panel: '#fdf6e3', panel2: '#f5efd9', panelHi: '#e8e0c7',
    accent: '#166596', secondary: '#8f4f21', text: '#4f6369', textDim: '#516269', textFaint: '#5a6262',
    bad: '#b42927', good: '#586500', review: '#1c6a64', queued: '#565a9d',
  },
  {
    id: 'github-light', label: 'GitHub Light', mode: 'light',
    bg: '#e8edf2', gutter: '#dbe2e9', panel: '#ffffff', panel2: '#f3f6f9', panelHi: '#e5eaf0',
    accent: '#085ec4', secondary: '#7447c6', text: '#1f2328', textDim: '#5c636b', textFaint: '#5c6269',
    bad: '#be1f2a', good: '#177232', review: '#0550ae', queued: '#7447c6',
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

export function applyThemeToDocument(theme: Theme, keys: readonly string[], fallbackBackground: string): void {
  const root: HTMLElement = document.documentElement;
  for (const key of keys) {
    const value: string | undefined = theme.vars[key];
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.vars['--bg'] ?? fallbackBackground);
}

export function applyTheme(id: string): void {
  if (typeof document === 'undefined') return;
  const theme: Theme = getTheme(id) ?? getTheme(DEFAULT_THEME_ID)!;
  applyThemeToDocument(theme, REQUIRED_VAR_KEYS, AMBER_BACKGROUND);
}

export function loadThemeId(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID;
    const stored: string | null = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && getTheme(stored)) return stored;
    return DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function saveThemeId(id: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    return;
  }
}
