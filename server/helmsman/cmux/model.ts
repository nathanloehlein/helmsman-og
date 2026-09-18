export interface CmuxTab {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  surfaceRef: string;
  surfaceTitle: string;
  type: 'terminal' | 'browser' | 'simulator' | 'agent-session' | string;
  cwd: string | null;
  selected: boolean;
}

interface WorkspaceInput {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  cwd: string | null;
}
interface SurfaceInput {
  surfaceRef: string;
  surfaceTitle: string;
  type: string;
  selected: boolean;
}

export function toTabs(workspaces: WorkspaceInput[], surfacesByWorkspace: Record<string, SurfaceInput[]>): CmuxTab[] {
  const tabs: CmuxTab[] = [];
  for (const ws of workspaces) {
    const surfaces = surfacesByWorkspace[ws.workspaceRef] ?? [];
    for (const s of surfaces) {
      tabs.push({
        windowRef: ws.windowRef,
        workspaceRef: ws.workspaceRef,
        workspaceTitle: ws.workspaceTitle,
        surfaceRef: s.surfaceRef,
        surfaceTitle: s.surfaceTitle,
        type: s.type,
        cwd: ws.cwd,
        selected: s.selected,
      });
    }
  }
  return tabs;
}
