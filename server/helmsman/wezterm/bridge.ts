import { spawn } from 'node:child_process';
import type { Bridge } from '../cmux/bridge';
import type { CmuxTab } from '../cmux/model';
import { keyToBytes } from './keys';
import { focusedPaneId, toTabs, type WezClient, type WezPane } from './model';
import { resolveSocket } from './socket';
import { providerFromTitle } from '../../../src/logic/agentProvider';

export type RunWez = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WezTermBridgeOptions {
  run?: RunWez;
  /** How often watchEvents re-lists panes. WezTerm has no event stream. */
  pollMs?: number;
  /** Where to reach wezterm, or null when there is nothing to drive. */
  socket?: () => string | null;
}

const POLL_MS = 1000;

const NOT_RUNNING = 'wezterm is not running';

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

export function createWezTermBridge(options: WezTermBridgeOptions = {}): Bridge {
  const run: RunWez = options.run ?? defaultRun;
  const pollMs: number = options.pollMs ?? POLL_MS;
  const target: () => string | null = options.socket ?? ((): string | null => resolveSocket());

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

  /**
   * Never shell out with nothing to connect to. `wezterm cli` falls back to its
   * default unix domain and, because that domain does not set
   * no_serve_automatically, silently starts a headless wezterm-mux-server. The
   * panel would then report connected and accept input for panes that have no
   * window — an invisible terminal, and a fresh orphan server per restart.
   *
   * Setting WEZTERM_SOCKET (or inheriting WEZTERM_UNIX_SOCKET) is the opt-in:
   * resolveSocket returns it whether or not a GUI is up, so deliberately
   * pointing at a headless mux domain still works.
   */
  async function listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    if (target() === null) return { connected: false, tabs: [] };
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
    if (target() === null) return { ok: false, error: NOT_RUNNING };
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

  /**
   * The only place user-controlled text reaches the terminal. Argv only, and
   * `--` terminates the options: without it wezterm parses text beginning with
   * a hyphen as its own flag. `--help` is the dangerous case -- it prints help
   * and exits 0, so the send looks successful while nothing was typed, and with
   * enter=true the Enter then lands on whatever the pane already held.
   */
  async function sendText(pane: string, text: string): Promise<{ code: number; stderr: string }> {
    const res = await run(['cli', 'send-text', '--pane-id', pane, '--no-paste', '--', text]);
    return { code: res.code, stderr: res.stderr };
  }

  async function send(
    surfaceRef: string,
    text: string,
    enter: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (target() === null) return { ok: false, error: NOT_RUNNING };
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
    if (target() === null) return { ok: false, error: NOT_RUNNING };
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
   * poll the pane list and fire only when its shape actually changes.
   *
   * The fingerprint tracks the derived provider rather than the raw title: the
   * panel's action buttons depend on it, so starting an agent in an existing
   * pane has to raise an event even though no id changed. Using the title
   * itself would instead fire on every title update, which for many shells is
   * every keystroke.
   */
  function watchEvents(onChange: () => void): () => void {
    let stopped = false;
    let last: string | null = null;
    let inFlight = false;

    const fingerprint = (tabs: CmuxTab[]): string =>
      tabs
        .map((t) => `${t.windowRef}/${t.workspaceRef}/${t.surfaceRef}/${t.selected}/${providerFromTitle(t.surfaceTitle) ?? ''}`)
        .join(',');

    const tick = async (): Promise<void> => {
      // setInterval does not wait, and a list can take seconds — wezterm blocks
      // for its connect timeout before spawning a mux server. Without this,
      // slow polls stack up and every tick spawns another pair of processes.
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const { connected, tabs } = await listTabs();
        const next = connected ? fingerprint(tabs) : 'disconnected';
        if (last !== null && next !== last) onChange();
        last = next;
      } finally {
        inFlight = false;
      }
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
