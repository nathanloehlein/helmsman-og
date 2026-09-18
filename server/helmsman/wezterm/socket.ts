import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `wezterm cli` can't find the GUI's socket on Windows: the GUI publishes only
 * the socket's *file name* into shared memory, so the client ends up trying to
 * connect to a relative path and fails with
 * `failed to connect to Socket("gui-sock-1234")`. See wezterm#4456 — fixed by
 * several open upstream PRs, none merged as of 2026-09.
 *
 * Setting WEZTERM_UNIX_SOCKET to the absolute path sidesteps discovery
 * entirely, on every platform. Resolution order:
 *   1. WEZTERM_UNIX_SOCKET — already set (e.g. helmsman itself launched from a
 *      wezterm pane, which exports it).
 *   2. WEZTERM_SOCKET — our own config, for a `unix_domain` pinned in
 *      wezterm.lua. Preferred for anything long-lived: a pid-derived path dies
 *      with the GUI it names, and it is the only deterministic option when
 *      several GUIs are running on Windows (see pickSock).
 *   3. Newest `gui-sock-*` in the runtime dir — mirrors wezterm's own
 *      discover_gui_socks(), so a plain install works with no setup.
 */

export interface SockCandidate {
  path: string;
  /** Socket pid, from the `gui-sock-<pid>` name. */
  pid: number;
  /** null when the socket can't be stat'd — always the case on Windows. */
  mtimeMs: number | null;
}

export function runtimeDir(home: string = homedir()): string {
  return join(home, '.local', 'share', 'wezterm');
}

/**
 * Windows refuses to stat an AF_UNIX socket (EACCES on both stat and lstat),
 * so mtime is best-effort; readdir still lists the entry.
 */
export function guiSockCandidates(dir: string): SockCandidate[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SockCandidate[] = [];
  for (const name of names) {
    const match = /^gui-sock-(\d+)$/.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Windows: EACCES on a socket. Keep the candidate, rank it by pid.
    }
    out.push({ path, pid: Number(match[1]), mtimeMs });
  }
  return out;
}

/**
 * WezTerm leaves the socket file behind when a GUI exits, so the runtime dir
 * accumulates dead sockets. Signal 0 checks for the process without touching
 * it; EPERM means it exists but isn't ours, which still counts as alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Liveness first: a stale socket is never the right answer, and ranking alone
 * picks it often enough to matter (a dead GUI can easily hold both the newer
 * mtime and the higher pid). Among live sockets prefer the newest, falling back
 * to the highest pid where mtime is unreadable — which on Windows is always,
 * since an AF_UNIX socket can't be stat'd. Pin WEZTERM_SOCKET if you run
 * several GUIs at once and care which one is driven.
 */
export function pickSock(candidates: SockCandidate[], alive: (pid: number) => boolean = isPidAlive): string | null {
  const live = candidates.filter((c) => alive(c.pid));
  if (live.length === 0) return null;
  const dated = live.filter((c) => c.mtimeMs !== null);
  const pool = dated.length > 0 ? dated : live;
  const best = pool.reduce((a, b) => {
    if (a.mtimeMs !== null && b.mtimeMs !== null) return b.mtimeMs > a.mtimeMs ? b : a;
    return b.pid > a.pid ? b : a;
  });
  return best.path;
}

export function newestGuiSock(dir: string, alive: (pid: number) => boolean = isPidAlive): string | null {
  return pickSock(guiSockCandidates(dir), alive);
}

export function resolveSocket(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = runtimeDir(),
  alive: (pid: number) => boolean = isPidAlive,
): string | null {
  return env.WEZTERM_UNIX_SOCKET || env.WEZTERM_SOCKET || newestGuiSock(dir, alive);
}
