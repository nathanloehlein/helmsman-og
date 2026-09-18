import { spawn } from 'node:child_process';
import type { Bridge } from '../cmux/bridge';
import type { CmuxTab } from '../cmux/model';
import { keyToBytes } from './keys';
import { focusedPaneId, toTabs, type WezClient, type WezPane } from './model';
import { resolveSocket } from './socket';

export type RunWez = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How often watchEvents re-lists panes. WezTerm has no event stream. */
const POLL_MS = 1000;

/**
 * Read at call time, not module scope: ESM evaluates this import before
 * main.ts runs loadEnvFile, so a module-scope read would never see .env.
 * WEZTERM_BIN matters on Windows, where the installer's PATH entry isn't
 * picked up by an already-running shell.
 */
const weztermBin = (): string => process.env.WEZTERM_BIN || 'wezterm';

const defaultRun: RunWez = (args) =>
  new Promise((resolve, reject) => {
    const socket = resolveSocket();
    const env = { ...process.env, ...(socket ? { WEZTERM_UNIX_SOCKET: socket } : {}) };
    const child = spawn(weztermBin(), args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

/**
 * A surfaceRef round-trips through the browser, so never let anything but a
 * pane id reach argv.
 */
function paneId(surfaceRef: string): string | null {
  return /^\d+$/.test(surfaceRef) ? surfaceRef : null;
}

/** WezTerm pads the viewport to the full pane height; drop the blank tail. */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/\s+$/, '');
}

export function createWezTermBridge(run: RunWez = defaultRun, pollMs: number = POLL_MS): Bridge {
  /**
   * Which pane has focus. Its own failure is not fatal — toTabs degrades to
   * per-tab is_active — so a broken list-clients must not take listTabs down.
   */
  async function readFocusedPane(): Promise<number | null> {
    try {
      const res = await run(['cli', 'list-clients', '--format', 'json']);
      if (res.code !== 0) return null;
      const clients = JSON.parse(res.stdout) as WezClient[];
      return Array.isArray(clients) ? focusedPaneId(clients) : null;
    } catch {
      return null;
    }
  }

  async function listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    try {
      const res = await run(['cli', 'list', '--format', 'json']);
      if (res.code !== 0) return { connected: false, tabs: [] };
      const panes = JSON.parse(res.stdout) as WezPane[];
      if (!Array.isArray(panes)) return { connected: false, tabs: [] };
      return { connected: true, tabs: toTabs(panes, await readFocusedPane()) };
    } catch {
      return { connected: false, tabs: [] };
    }
  }

  async function readScreen(
    surfaceRef: string,
    lines: number,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const pane = paneId(surfaceRef);
    if (!pane) return { ok: false, error: `not a wezterm pane id: ${surfaceRef}` };
    try {
      const res = await run(['cli', 'get-text', '--pane-id', pane, '--start-line', `-${lines}`]);
      return res.code === 0
        ? { ok: true, text: trimTrailingBlankLines(res.stdout) }
        : { ok: false, error: res.stderr || 'read failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'wezterm unavailable' };
    }
  }

  /** The only place user-controlled text reaches the terminal. Argv only. */
  async function sendText(pane: string, text: string): Promise<{ code: number; stderr: string }> {
    const res = await run(['cli', 'send-text', '--pane-id', pane, '--no-paste', text]);
    return { code: res.code, stderr: res.stderr };
  }

  async function send(
    surfaceRef: string,
    text: string,
    enter: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const pane = paneId(surfaceRef);
    if (!pane) return { ok: false, error: `not a wezterm pane id: ${surfaceRef}` };
    try {
      const res = await sendText(pane, text);
      if (res.code !== 0) return { ok: false, error: res.stderr || 'send failed' };
      if (enter) {
        const k = await sendText(pane, '\r');
        if (k.code !== 0) return { ok: false, error: k.stderr || 'enter failed' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'wezterm unavailable' };
    }
  }

  async function sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pane = paneId(surfaceRef);
    if (!pane) return { ok: false, error: `not a wezterm pane id: ${surfaceRef}` };
    const bytes = keyToBytes(key);
    if (bytes === null) return { ok: false, error: `unsupported key: ${key}` };
    try {
      const res = await sendText(pane, bytes);
      return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr || 'send-key failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'wezterm unavailable' };
    }
  }

  /**
   * cmux pushes tree changes over `cmux events`; wezterm has no equivalent, so
   * poll the pane list and fire only when its shape actually changes. The
   * fingerprint deliberately ignores titles and cwd — the panel re-fetches on
   * every change, and a title that updates per keystroke would make this a
   * busy loop.
   */
  function watchEvents(onChange: () => void): () => void {
    let stopped = false;
    let last: string | null = null;

    const fingerprint = (tabs: CmuxTab[]): string =>
      tabs.map((t) => `${t.windowRef}/${t.workspaceRef}/${t.surfaceRef}/${t.selected}`).join(',');

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const { connected, tabs } = await listTabs();
      const next = connected ? fingerprint(tabs) : 'disconnected';
      if (last !== null && next !== last) onChange();
      last = next;
    };

    const timer = setInterval(() => {
      void tick();
    }, pollMs);
    void tick();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { listTabs, readScreen, send, sendKey, watchEvents };
}
