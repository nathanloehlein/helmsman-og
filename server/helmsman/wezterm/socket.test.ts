import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPidAlive, newestGuiSock, pickSock, resolveSocket, runtimeDir, type SockCandidate } from './socket';

const ALIVE = (): boolean => true;

const dirs: string[] = [];
function fixture(files: Array<{ name: string; ageSeconds: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wez-sock-'));
  dirs.push(dir);
  for (const f of files) {
    const path = join(dir, f.name);
    writeFileSync(path, '');
    const when = new Date(Date.now() - f.ageSeconds * 1000);
    utimesSync(path, when, when);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('newestGuiSock', () => {
  it('picks the most recent socket, which is the live GUI', () => {
    const dir = fixture([
      { name: 'gui-sock-100', ageSeconds: 600 },
      { name: 'gui-sock-200', ageSeconds: 5 },
    ]);
    expect(newestGuiSock(dir, ALIVE)).toBe(join(dir, 'gui-sock-200'));
  });

  it('ignores files that are not sockets', () => {
    const dir = fixture([{ name: 'wezterm.exe-log-1.txt', ageSeconds: 1 }]);
    expect(newestGuiSock(dir, ALIVE)).toBeNull();
  });

  it('ignores a socket whose GUI has exited', () => {
    const dir = fixture([{ name: 'gui-sock-100', ageSeconds: 1 }]);
    expect(newestGuiSock(dir, () => false)).toBeNull();
  });

  it('returns null when the runtime dir does not exist', () => {
    expect(newestGuiSock(join(tmpdir(), 'definitely-not-here-9f3a'), ALIVE)).toBeNull();
  });
});

describe('pickSock', () => {
  const c = (pid: number, mtimeMs: number | null): SockCandidate => ({ path: `/r/gui-sock-${pid}`, pid, mtimeMs });

  it('prefers the newest when mtime is readable', () => {
    expect(pickSock([c(100, 1000), c(200, 5000), c(300, 2000)], ALIVE)).toBe('/r/gui-sock-200');
  });

  // Windows cannot stat an AF_UNIX socket (EACCES), so every mtime is null.
  it('falls back to the highest pid when no mtime is readable', () => {
    expect(pickSock([c(100, null), c(300, null), c(200, null)], ALIVE)).toBe('/r/gui-sock-300');
  });

  it('ignores undatable candidates when at least one is datable', () => {
    expect(pickSock([c(900, null), c(100, 1000)], ALIVE)).toBe('/r/gui-sock-100');
  });

  // The exact case that broke a live run: a dead GUI left a socket behind whose
  // pid outranks the running one's.
  it('skips a dead socket even when it outranks every live one', () => {
    const live = new Set([78640]);
    expect(pickSock([c(100960, null), c(78640, null)], (pid) => live.has(pid))).toBe('/r/gui-sock-78640');
  });

  it('returns null when every candidate is dead', () => {
    expect(pickSock([c(1, null)], () => false)).toBeNull();
  });

  it('returns null for no candidates', () => {
    expect(pickSock([], ALIVE)).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('reports this process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(isPidAlive(0x7ffffff0)).toBe(false);
  });
});

describe('resolveSocket', () => {
  it('prefers an inherited WEZTERM_UNIX_SOCKET', () => {
    const dir = fixture([{ name: 'gui-sock-1', ageSeconds: 1 }]);
    expect(resolveSocket({ WEZTERM_UNIX_SOCKET: '/from/env' }, dir, ALIVE)).toBe('/from/env');
  });

  it('falls back to the configured WEZTERM_SOCKET', () => {
    const dir = fixture([{ name: 'gui-sock-1', ageSeconds: 1 }]);
    expect(resolveSocket({ WEZTERM_SOCKET: '/pinned/domain' }, dir, ALIVE)).toBe('/pinned/domain');
  });

  it('discovers the runtime dir socket when nothing is configured', () => {
    const dir = fixture([{ name: 'gui-sock-42', ageSeconds: 1 }]);
    expect(resolveSocket({}, dir, ALIVE)).toBe(join(dir, 'gui-sock-42'));
  });

  it('returns null when there is nothing to find', () => {
    expect(resolveSocket({}, fixture([]), ALIVE)).toBeNull();
  });
});

describe('runtimeDir', () => {
  it('matches the path wezterm publishes into', () => {
    expect(runtimeDir('/home/n')).toBe(join('/home/n', '.local', 'share', 'wezterm'));
  });
});
