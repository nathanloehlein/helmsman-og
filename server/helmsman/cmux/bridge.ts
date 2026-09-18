import { spawn, type ChildProcess } from 'node:child_process';
import { toTabs, type CmuxTab } from './model';

export type RunCmux = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type SpawnEventsChild = () => ChildProcess;

export interface Bridge {
  listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }>;
  readScreen(surfaceRef: string, lines: number): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  send(surfaceRef: string, text: string, enter: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>;
  watchEvents(onChange: () => void): () => void;
}

const defaultRun: RunCmux = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('cmux', args, { env: { ...process.env, CMUX_QUIET: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

const defaultSpawnEventsChild: SpawnEventsChild = () =>
  spawn('cmux', ['events', '--reconnect', '--no-heartbeat'], { env: { ...process.env, CMUX_QUIET: '1' } });

function pickTitle(w: { title?: string; custom_title?: string | null; ref: string }): string {
  return w.title ?? w.custom_title ?? w.ref;
}

function tryParseEvent(line: string): { type?: string; category?: string } | null {
  try {
    return JSON.parse(line) as { type?: string; category?: string };
  } catch {
    return null;
  }
}

interface RawWorkspace {
  ref: string;
  title?: string;
  custom_title?: string | null;
  current_directory?: string | null;
}
interface RawSurface {
  ref: string;
  title: string;
  type: string;
  selected: boolean;
}
interface WorkspaceEntry {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  cwd: string | null;
}
interface SurfaceEntry {
  surfaceRef: string;
  surfaceTitle: string;
  type: string;
  selected: boolean;
}

export function createBridge(run: RunCmux = defaultRun, spawnEventsChild: SpawnEventsChild = defaultSpawnEventsChild): Bridge {
  function toWorkspaceEntries(windowRef: string, workspaces: RawWorkspace[]): WorkspaceEntry[] {
    return workspaces.map((w) => ({
      windowRef,
      workspaceRef: w.ref,
      workspaceTitle: pickTitle({ ...w, ref: w.ref }),
      cwd: w.current_directory ?? null,
    }));
  }

  async function fetchSurfacesFor(workspaceRef: string): Promise<SurfaceEntry[] | null> {
    const sRes = await run(['list-pane-surfaces', '--workspace', workspaceRef, '--json']);
    if (sRes.code !== 0) return null;
    const sParsed = JSON.parse(sRes.stdout) as { surfaces: RawSurface[] };
    return sParsed.surfaces.map((s) => ({ surfaceRef: s.ref, surfaceTitle: s.title, type: s.type, selected: s.selected }));
  }

  async function listWindowIds(): Promise<string[]> {
    try {
      const res = await run(['list-windows', '--json']);
      if (res.code !== 0) return [];
      const parsed = JSON.parse(res.stdout) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((w) => (typeof w === 'object' && w !== null && 'id' in w ? String((w as { id: unknown }).id) : null))
        .filter((id): id is string => id !== null);
    } catch {
      return [];
    }
  }

  async function collectTabsForWindows(windowIds: string[]): Promise<CmuxTab[] | null> {
    const workspaces: WorkspaceEntry[] = [];
    const surfacesByWorkspace: Record<string, SurfaceEntry[]> = {};
    for (const windowId of windowIds) {
      const wsRes = await run(['workspace', 'list', '--window', windowId, '--json']);
      if (wsRes.code !== 0) continue;
      const parsed = JSON.parse(wsRes.stdout) as { window_ref: string; workspaces: RawWorkspace[] };
      const entries = toWorkspaceEntries(parsed.window_ref, parsed.workspaces);
      for (const entry of entries) {
        const surfaces = await fetchSurfacesFor(entry.workspaceRef);
        if (surfaces === null) continue;
        workspaces.push(entry);
        surfacesByWorkspace[entry.workspaceRef] = surfaces;
      }
    }
    if (workspaces.length === 0) return null;
    return toTabs(workspaces, surfacesByWorkspace);
  }

  async function listTabsSingleWindow(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    const wsRes = await run(['workspace', 'list', '--json']);
    if (wsRes.code !== 0) return { connected: false, tabs: [] };
    const parsed = JSON.parse(wsRes.stdout) as { window_ref: string; workspaces: RawWorkspace[] };
    const workspaces = toWorkspaceEntries(parsed.window_ref, parsed.workspaces);
    const surfacesByWorkspace: Record<string, SurfaceEntry[]> = {};
    for (const w of workspaces) {
      const surfaces = await fetchSurfacesFor(w.workspaceRef);
      if (surfaces === null) continue;
      surfacesByWorkspace[w.workspaceRef] = surfaces;
    }
    return { connected: true, tabs: toTabs(workspaces, surfacesByWorkspace) };
  }

  async function listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    try {
      const windowIds = await listWindowIds();
      if (windowIds.length > 0) {
        const tabs = await collectTabsForWindows(windowIds);
        if (tabs !== null) return { connected: true, tabs };
      }
      return await listTabsSingleWindow();
    } catch {
      return { connected: false, tabs: [] };
    }
  }

  async function readScreen(surfaceRef: string, lines: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const res = await run(['read-screen', '--surface', surfaceRef, '--lines', String(lines)]);
      return res.code === 0 ? { ok: true, text: res.stdout } : { ok: false, error: res.stderr || 'read failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  async function send(surfaceRef: string, text: string, enter: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await run(['send', '--surface', surfaceRef, text]);
      if (res.code !== 0) return { ok: false, error: res.stderr || 'send failed' };
      if (enter) {
        const k = await run(['send-key', '--surface', surfaceRef, 'Enter']);
        if (k.code !== 0) return { ok: false, error: k.stderr || 'enter failed' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  async function sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await run(['send-key', '--surface', surfaceRef, key]);
      return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr || 'send-key failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  function watchEvents(onChange: () => void): () => void {
    const INITIAL_BACKOFF_MS = 1000;
    const MAX_BACKOFF_MS = 10000;
    let stopped = false;
    let child: ChildProcess | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = INITIAL_BACKOFF_MS;

    function scheduleRespawn(): void {
      if (stopped) return;
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        start();
      }, delay);
    }

    function start(): void {
      if (stopped) return;
      const c = spawnEventsChild();
      child = c;
      let buf = '';
      let done = false;
      const onDone = (): void => {
        if (done) return;
        done = true;
        if (child === c) child = null;
        scheduleRespawn();
      };
      c.stdout?.on('data', (d: unknown) => {
        buf += String(d);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          backoffMs = INITIAL_BACKOFF_MS;
          const ev = tryParseEvent(line);
          if (ev?.type === 'event' && (ev.category === 'workspace' || ev.category === 'sidebar')) onChange();
        }
      });
      c.on('error', onDone);
      c.on('close', onDone);
      c.on('exit', onDone);
    }

    start();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      child?.kill();
    };
  }

  return { listTabs, readScreen, send, sendKey, watchEvents };
}
