import { fileURLToPath } from 'node:url';
import type { CmuxTab } from '../cmux/model';

/** One row of `wezterm cli list --format json`. */
export interface WezPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  workspace?: string;
  title?: string;
  tab_title?: string;
  window_title?: string;
  cwd?: string | null;
  is_active?: boolean;
}

/**
 * WezTerm reports cwd as a URL (`file:///C:/Users/natha/`), not a path.
 *
 * A drive-letter URL is normalized before any platform-dependent conversion,
 * because fileURLToPath disagrees across platforms: on Windows it yields
 * `C:\Users\natha`, on macOS and Linux it happily returns `/C:/Users/natha`,
 * leading slash and all. Handling it here means the same URL produces the same
 * drive path everywhere, so behaviour does not depend on where helmsman runs.
 */
export function cwdFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('file://')) return raw;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(raw).pathname);
  } catch {
    return null;
  }

  if (/^\/[a-zA-Z]:/.test(pathname)) {
    const drivePath = pathname.slice(1);
    return process.platform === 'win32' ? drivePath.replace(/\//g, '\\') : drivePath;
  }

  // Not a drive letter: a POSIX path, or a UNC share wezterm reports for a
  // remote domain. fileURLToPath handles both, and rejects an authority it
  // cannot map, in which case the decoded pathname is the best available.
  try {
    return fileURLToPath(raw);
  } catch {
    return pathname;
  }
}

function tabTitle(p: WezPane): string {
  return p.tab_title || p.workspace || `tab ${p.tab_id}`;
}

/**
 * WezTerm's pane list is already flat — one row per pane — so this is a
 * straight projection onto CmuxTab. The four-level cmux model
 * (window > workspace > pane > surface) collapses to window > tab > pane.
 *
 * WezTerm has no surface types, so everything is a terminal; the panel's
 * provider detection falls back to a title heuristic.
 *
 * `selected` means the one focused surface, so `is_active` alone won't do: it
 * is per-tab, and marks the active pane of *every* tab. focusedPaneId comes
 * from `wezterm cli list-clients`; without it (older wezterm, or the call
 * failed) fall back to is_active and accept one highlight per tab.
 */
export function toTabs(panes: WezPane[], focusedPaneId: number | null = null): CmuxTab[] {
  const isSelected = (p: WezPane): boolean =>
    focusedPaneId === null ? p.is_active === true : p.pane_id === focusedPaneId;
  return panes.map((p) => ({
    windowRef: `window:${p.window_id}`,
    workspaceRef: `tab:${p.tab_id}`,
    workspaceTitle: tabTitle(p),
    surfaceRef: String(p.pane_id),
    surfaceTitle: p.title || `pane ${p.pane_id}`,
    type: 'terminal',
    cwd: cwdFromUrl(p.cwd),
    selected: isSelected(p),
  }));
}

/** One row of `wezterm cli list-clients --format json`. */
export interface WezClient {
  focused_pane_id?: number | null;
}

/** The focused pane across all clients, or null if nothing reports one. */
export function focusedPaneId(clients: WezClient[]): number | null {
  for (const c of clients) {
    if (typeof c.focused_pane_id === 'number') return c.focused_pane_id;
  }
  return null;
}
