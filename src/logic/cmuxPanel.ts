export interface CmuxTabView {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  surfaceRef: string;
  surfaceTitle: string;
  type: string;
  cwd: string | null;
  selected: boolean;
}

export interface PanelState {
  selectedSurface: string | null;
}

export function selectSurface(state: PanelState, surfaceRef: string): PanelState {
  return { ...state, selectedSurface: surfaceRef };
}

export function isPolling(state: PanelState): boolean {
  return state.selectedSurface !== null;
}

/**
 * Agent CLIs, as they appear in a pane title. Word-bounded so `claude-config`
 * or a path containing the name doesn't match.
 */
const PROVIDER_TITLES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[^a-z0-9-])claude([^a-z0-9-]|$)/i, 'claude'],
  [/(^|[^a-z0-9-])codex([^a-z0-9-]|$)/i, 'codex'],
  [/(^|[^a-z0-9-])opencode([^a-z0-9-]|$)/i, 'opencode'],
];

function providerFromTitle(title: string): string | null {
  for (const [pattern, provider] of PROVIDER_TITLES) {
    if (pattern.test(title)) return provider;
  }
  return null;
}

/**
 * cmux types its surfaces, so an agent-session is known to be one; the title
 * only refines which provider it is. wezterm has no surface types — every pane
 * is a terminal — so there the running command's title is all we have.
 */
export function providerOf(tab: CmuxTabView): string | null {
  const fromTitle = providerFromTitle(tab.surfaceTitle);
  if (tab.type === 'agent-session') return fromTitle ?? 'claude';
  return fromTitle;
}
