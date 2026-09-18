import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolveSocket } from './wezterm/socket';

export interface LaunchSpec {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
  logPath: string;
  exitPath: string;
  specPath: string;
}

export type HostRef =
  | { kind: 'detached'; pid: number }
  | { kind: 'cmux'; workspace: string }
  | { kind: 'wezterm'; paneId: string };

export interface RunHost {
  kind: HostRef['kind'];
  launch(spec: LaunchSpec): Promise<HostRef>;
  isAlive(ref: HostRef): Promise<boolean>;
  stop(ref: HostRef): Promise<void>;
}

export type ArgvRunner = (argv: string[]) => Promise<{ stdout: string; code: number }>;

function writeSpecFile(spec: LaunchSpec): void {
  writeFileSync(spec.specPath, JSON.stringify({ cmd: spec.cmd, args: spec.args, cwd: spec.cwd, logPath: spec.logPath, exitPath: spec.exitPath }));
}

export function detachedHost(wrapperPath: string): RunHost {
  return {
    kind: 'detached',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      writeSpecFile(spec);
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.JIRA_API_TOKEN;
      delete env.JIRA_EMAIL;
      const child = spawn('node', [wrapperPath, spec.specPath], { detached: true, stdio: 'ignore', env });
      child.unref();
      return { kind: 'detached', pid: child.pid! };
    },

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'detached') return false;
      try {
        process.kill(ref.pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'detached') return;
      try {
        process.kill(-ref.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(ref.pid, 'SIGTERM');
        } catch {}
      }
    },
  };
}

const execFileAsync = promisify(execFile);

export const defaultRun: ArgvRunner = async (argv: string[]): Promise<{ stdout: string; code: number }> => {
  const [bin, ...args] = argv;
  const { stdout } = await execFileAsync(bin!, args, { env: { ...process.env, CMUX_QUIET: '1' } });
  return { stdout, code: 0 };
};

export function parseCmuxWorkspaceRef(stdout: string): string {
  const match = stdout.match(/workspace:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`could not parse a cmux workspace ref from: ${stdout}`);
  return match[0];
}

export function cmuxHost(wrapperPath: string, run: ArgvRunner = defaultRun): RunHost {
  return {
    kind: 'cmux',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      writeSpecFile(spec);
      const command = `node ${wrapperPath} ${spec.specPath}`;
      const { stdout } = await run(['cmux', 'new-workspace', '--cwd', spec.cwd, '--focus', 'false', '--name', `run-${spec.runId}`, '--command', command]);
      return { kind: 'cmux', workspace: parseCmuxWorkspaceRef(stdout) };
    },

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'cmux') return false;
      try {
        const { stdout } = await run(['cmux', 'list-workspaces']);
        return stdout.includes(ref.workspace);
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'cmux') return;
      try {
        await run(['cmux', 'close-workspace', '--workspace', ref.workspace]);
      } catch {}
    },
  };
}

/**
 * Runs `wezterm` with the socket resolved, since `wezterm cli` cannot find the
 * GUI's socket on Windows by itself. argv[0] is the literal 'wezterm' so the
 * built argv stays readable and assertable; the configured binary is
 * substituted here, because on Windows the installer's PATH entry is not
 * visible to an already-running shell.
 */
export const weztermRun: ArgvRunner = async (argv: string[]): Promise<{ stdout: string; code: number }> => {
  const [, ...args] = argv;
  const socket = resolveSocket();
  const env: NodeJS.ProcessEnv = { ...process.env, ...(socket ? { WEZTERM_UNIX_SOCKET: socket } : {}) };
  const { stdout } = await execFileAsync(process.env.WEZTERM_BIN || 'wezterm', args, { env });
  return { stdout, code: 0 };
};

export function parseWezPaneId(stdout: string): string {
  const match = stdout.trim().match(/^\d+$/m);
  if (!match) throw new Error(`could not parse a wezterm pane id from: ${stdout}`);
  return match[0];
}

/** Keeps run windows out of the workspace the user is looking at. */
const RUN_WORKSPACE = (): string => process.env.WEZTERM_RUN_WORKSPACE || 'helmsman-runs';

export function weztermHost(wrapperPath: string, run: ArgvRunner = weztermRun): RunHost {
  return {
    kind: 'wezterm',

    async launch(spec: LaunchSpec): Promise<HostRef> {
      writeSpecFile(spec);
      // --workspace requires --new-window; together they put the run in its own
      // window on a workspace the user is not currently viewing, which is the
      // closest wezterm gets to cmux's --focus false.
      const { stdout } = await run([
        'wezterm', 'cli', 'spawn',
        '--new-window', '--workspace', RUN_WORKSPACE(),
        '--cwd', spec.cwd,
        '--', 'node', wrapperPath, spec.specPath,
      ]);
      return { kind: 'wezterm', paneId: parseWezPaneId(stdout) };
    },

    async isAlive(ref: HostRef): Promise<boolean> {
      if (ref.kind !== 'wezterm') return false;
      try {
        const { stdout } = await run(['wezterm', 'cli', 'list', '--format', 'json']);
        const panes = JSON.parse(stdout) as Array<{ pane_id: number }>;
        return Array.isArray(panes) && panes.some((p) => String(p.pane_id) === ref.paneId);
      } catch {
        return false;
      }
    },

    async stop(ref: HostRef): Promise<void> {
      if (ref.kind !== 'wezterm') return;
      try {
        await run(['wezterm', 'cli', 'kill-pane', '--pane-id', ref.paneId]);
      } catch {}
    },
  };
}

/**
 * Checks the socket before shelling out: `wezterm cli` with no reachable socket
 * silently daemonizes a headless wezterm-mux-server, and probing for
 * availability must not be the thing that creates it.
 */
export const hasWezTerm = async (run: ArgvRunner = weztermRun): Promise<boolean> => {
  if (resolveSocket() === null) return false;
  try {
    const { code } = await run(['wezterm', 'cli', 'list', '--format', 'json']);
    return code === 0;
  } catch {
    return false;
  }
};

export const hasCmux = async (run: ArgvRunner = defaultRun): Promise<boolean> => {
  try {
    const { code } = await run(['cmux', 'list-workspaces']);
    return code === 0;
  } catch {
    return false;
  }
};

export interface PickHostDeps {
  hasCmux: () => Promise<boolean>;
  hasWezTerm?: () => Promise<boolean>;
  wrapperPath: string;
  /** RUN_HOST. Anything else, or a terminal that isn't there, means detached. */
  prefer: HostRef['kind'] | null;
}

export async function pickHost(deps: PickHostDeps): Promise<RunHost> {
  if (deps.prefer === 'cmux' && (await deps.hasCmux())) return cmuxHost(deps.wrapperPath);
  if (deps.prefer === 'wezterm' && (await (deps.hasWezTerm ?? hasWezTerm)())) return weztermHost(deps.wrapperPath);
  return detachedHost(deps.wrapperPath);
}
