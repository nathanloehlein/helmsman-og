import { spawn } from 'node:child_process';
import { toTabs, type CmuxTab } from './model';

export type RunCmux = (args: string[], opts?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

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

export function createBridge(run: RunCmux = defaultRun): Bridge {
  async function listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    try {
      const wsRes = await run(['workspace', 'list', '--json']);
      if (wsRes.code !== 0) return { connected: false, tabs: [] };
      const parsed = JSON.parse(wsRes.stdout) as {
        window_ref: string;
        workspaces: { ref: string; title?: string; custom_title?: string | null; current_directory?: string | null }[];
      };
      const workspaces = parsed.workspaces.map((w) => ({
        windowRef: parsed.window_ref,
        workspaceRef: w.ref,
        workspaceTitle: pickTitle({ ...w, ref: w.ref }),
        cwd: w.current_directory ?? null,
      }));
      const surfacesByWorkspace: Record<string, { surfaceRef: string; surfaceTitle: string; type: string; selected: boolean }[]> = {};
      for (const w of workspaces) {
        const sRes = await run(['list-pane-surfaces', '--workspace', w.workspaceRef, '--json']);
        if (sRes.code !== 0) continue;
        const sParsed = JSON.parse(sRes.stdout) as { surfaces: { ref: string; title: string; type: string; selected: boolean }[] };
        surfacesByWorkspace[w.workspaceRef] = sParsed.surfaces.map((s) => ({
          surfaceRef: s.ref,
          surfaceTitle: s.title,
          type: s.type,
          selected: s.selected,
        }));
      }
      return { connected: true, tabs: toTabs(workspaces, surfacesByWorkspace) };
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
    const child = spawn('cmux', ['events', '--reconnect', '--no-heartbeat'], { env: { ...process.env, CMUX_QUIET: '1' } });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = tryParseEvent(line);
        if (ev?.type === 'event' && (ev.category === 'workspace' || ev.category === 'sidebar')) onChange();
      }
    });
    child.on('error', () => {});
    return () => child.kill();
  }

  return { listTabs, readScreen, send, sendKey, watchEvents };
}
