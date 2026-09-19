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

export function parseCmuxTabs(value: unknown): { connected: boolean; tabs: CmuxTabView[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.connected !== 'boolean' || !Array.isArray(payload.tabs)) return null;
  const valid = payload.tabs.every((item: unknown): item is CmuxTabView => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const tab = item as Record<string, unknown>;
    return ['windowRef', 'workspaceRef', 'workspaceTitle', 'surfaceRef', 'surfaceTitle', 'type'].every(key => typeof tab[key] === 'string')
      && typeof tab.surfaceRef === 'string' && tab.surfaceRef.length > 0
      && (tab.cwd === null || typeof tab.cwd === 'string') && typeof tab.selected === 'boolean';
  });
  return valid ? { connected: payload.connected, tabs: payload.connected ? payload.tabs : [] } : null;
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
