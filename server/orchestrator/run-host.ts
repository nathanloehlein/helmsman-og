import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

export interface LaunchSpec {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
  logPath: string;
  exitPath: string;
  specPath: string;
}

export type HostRef = { kind: 'detached'; pid: number } | { kind: 'cmux'; workspace: string };

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
  wrapperPath: string;
  preferCmux: boolean;
}

export async function pickHost(deps: PickHostDeps): Promise<RunHost> {
  return deps.preferCmux && (await deps.hasCmux()) ? cmuxHost(deps.wrapperPath) : detachedHost(deps.wrapperPath);
}
