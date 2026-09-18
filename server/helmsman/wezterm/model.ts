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
 * fileURLToPath rejects a non-localhost authority, which WezTerm can emit for a
 * remote domain, so fall back to decoding the pathname by hand.
 */
export function cwdFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('file://')) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    try {
      const path = decodeURIComponent(new URL(raw).pathname);
      // A Windows path arrives as `/C:/Users/...`; strip the leading slash.
      return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
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
