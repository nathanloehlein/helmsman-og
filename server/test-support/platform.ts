import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Capability probes for tests that depend on POSIX behaviour.
 *
 * Suites gated on these skip with a named reason on Windows instead of failing,
 * so a Windows run is green and a genuine regression still stands out. Each
 * constant records what is actually missing, not just "not Windows".
 */

export const isWindows: boolean = process.platform === 'win32';

/**
 * Fake CLIs are shell/shebang scripts dropped on PATH under their real names
 * (`git`, `gh`). Windows resolves executables by extension and does not honour
 * a shebang, so those shims can never be invoked there.
 */
export const hasShebangShims: boolean = !isWindows;

/** `process.kill(-pid)` — Windows has no process groups. */
export const hasProcessGroups: boolean = !isWindows;

/** NTFS rejects control characters, so a path cannot contain a newline. */
export const allowsControlCharsInPaths: boolean = !isWindows;

let fileSymlinkChecked = false;
let fileSymlinkAllowed = false;

/**
 * Creating a *file* symlink on Windows needs Developer Mode or elevation, so it
 * is a property of the machine rather than the platform. Probed once, for real,
 * because guessing from process.platform would skip on a Windows box that can
 * do it. Directory links are not covered: use junctionOrSymlink for those,
 * which needs no privilege.
 */
export function canCreateFileSymlink(): boolean {
  if (fileSymlinkChecked) return fileSymlinkAllowed;
  fileSymlinkChecked = true;
  const dir = mkdtempSync(join(tmpdir(), 'helmsman-symlink-probe-'));
  try {
    const target = join(dir, 'target');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, 'link'), 'file');
    fileSymlinkAllowed = true;
  } catch {
    fileSymlinkAllowed = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return fileSymlinkAllowed;
}

/**
 * A junction is Windows' unprivileged directory link and is what the code under
 * test has to treat as a symlink escape, so directory-link tests run for real
 * on Windows rather than being skipped.
 */
export function directoryLinkType(): 'dir' | 'junction' {
  return isWindows ? 'junction' : 'dir';
}

/** PATH entries join with ':' on POSIX and ';' on Windows. */
export function prependPath(dir: string, path: string = process.env.PATH ?? ''): string {
  return `${dir}${delimiter}${path}`;
}

let cachedGit: string | null = null;

/**
 * Resolve git from PATH instead of assuming /usr/bin/git, which is wrong
 * anywhere git is installed elsewhere (Homebrew, nix, Windows).
 */
export function gitBin(): string {
  if (cachedGit !== null) return cachedGit;
  if (process.env.HELMSMAN_TEST_GIT_BIN) return (cachedGit = process.env.HELMSMAN_TEST_GIT_BIN);
  const probe = isWindows ? ['where', 'git'] : ['which', 'git'];
  try {
    const found = execFileSync(probe[0]!, probe.slice(1), { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
    cachedGit = found || 'git';
  } catch {
    cachedGit = 'git';
  }
  return cachedGit;
}
