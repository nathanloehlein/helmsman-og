export type PageView = 'dashboard' | 'triage' | 'cmux' | 'bugs' | 'prs' | 'config' | 'runs';

export interface AppRoute {
  view: PageView;
  repo: string | null;
  pane: string | null;
  pr: number | null;
  run: string | null;
  mode: 'review' | 'rerun' | null;
  ticket: string | null;
  surface: string | null;
}

const paths: Record<PageView, string> = {
  dashboard: '/helm',
  triage: '/triage',
  cmux: '/terminal',
  bugs: '/bugs',
  prs: '/prs',
  config: '/config',
  runs: '/runs',
};

const panes: Record<PageView, readonly string[]> = {
  dashboard: ['newrun', 'backlog', 'underway', 'running', 'recent', 'repoprs', 'shipped', 'activity'],
  triage: ['backlog', 'todo', 'mine'],
  cmux: ['tabs', 'screen'],
  bugs: [],
  prs: ['review-requests', 'authored', 'lookup', 'diff'],
  config: ['local-git'],
  runs: ['recent', 'newrun', 'tasks'],
};

function validRepo(value: string | null): string | null {
  if (!value) return null;
  const [owner, name, extra] = value.split('/');
  if (extra !== undefined || !owner || !name) return null;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) return null;
  return /^[a-z\d_.-]{1,100}$/i.test(name) && name !== '.' && name !== '..' ? value : null;
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function parseRoute(url: URL): AppRoute {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const view = pathname === '/pr' ? 'prs'
    : pathname === '/cmux' ? 'cmux'
    : (Object.keys(paths) as PageView[]).find((page) => paths[page] === pathname) ?? 'dashboard';
  const params = url.searchParams;
  const repo = validRepo(params.get('repo'));
  const pane = params.get('pane');
  const run = params.get('run');
  const mode = params.get('mode');
  const ticket = params.get('ticket');
  const surface = params.get('surface');

  return {
    view,
    repo,
    pane: pane && panes[view].includes(pane) ? pane : null,
    pr: repo ? positiveInteger(params.get('pr')) : null,
    run: run && /^[a-z\d_-]{1,128}$/i.test(run) ? run : null,
    mode: (view === 'runs' || view === 'prs') && (mode === 'review' || mode === 'rerun') ? mode : null,
    ticket: ticket && /^[a-z][a-z\d_]{0,49}-[1-9]\d{0,14}$/i.test(ticket) ? ticket.toUpperCase() : null,
    surface: view === 'cmux' && surface?.startsWith('surface:') && positiveInteger(surface.slice(8))
      ? surface : null,
  };
}

export function routeHref(route: Partial<AppRoute> & { view: PageView }): string {
  const url = new URL(paths[route.view], 'http://helmsman.local');
  const keys = ['repo', 'pane', 'pr', 'run', 'mode', 'ticket', 'surface'] as const;
  for (const key of keys) {
    const value = route[key];
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const normalized = parseRoute(url);
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = normalized[key];
    if (value !== null) params.set(key, String(value));
  }
  const query = params.toString();
  return `${paths[normalized.view]}${query ? `?${query}` : ''}`;
}
