import { providerFromTitle } from './agentProvider';

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

export function providerOf(tab: CmuxTabView): string | null {
  const fromTitle = providerFromTitle(tab.surfaceTitle);
  if (tab.type === 'agent-session') return fromTitle ?? 'claude';
  return fromTitle;
}
