import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, readlink, symlink, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HostRef, LaunchSpec, RunHost } from './run-host';

export type DockerRun = (argv: string[]) => Promise<{ stdout: string; code: number }>;
const exec = promisify(execFile);
export const dockerRun: DockerRun = async argv => { const [bin, ...args] = argv; const result = await exec(bin!, args); return { stdout: result.stdout, code: 0 }; };

export interface DockerHostOptions { image: string; runtimeRoot: string; wrapperPath: string; run: DockerRun; enabled: boolean; }
const safe = (value: string) => /^[a-z\d_-]{1,128}$/i.test(value);
async function link(path: string, target: string): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); try { const stat = await lstat(path); if (!stat.isSymbolicLink() || await readlink(path) !== target) throw new Error(`Docker output path is occupied: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await symlink(target, path); else if (error instanceof Error && error.message.startsWith('Docker output')) throw error; else throw error; } }

export function dockerHost(options: DockerHostOptions): RunHost {
  const run = options.run;
  return {
    kind: 'docker',
    async launch(spec: LaunchSpec): Promise<HostRef> {
      if (!options.enabled) throw new Error('Docker run host is disabled');
      if (!safe(spec.runId) || !options.image) throw new Error('Invalid Docker run specification');
      if ([spec.cmd, ...spec.args].some(arg => /(?:^|[\\/])(?:pre-pr-cli|docker-review-cli)\.ts$/.test(arg))) {
        throw new Error('Pre-PR and Docker review coordinators must execute on the host');
      }
      const git = await lstat(join(spec.cwd, '.git')).catch(() => null);
      if (git?.isFile()) throw new Error('Docker host cannot run a linked Git worktree; provision a standalone clone first.');
      const runtime = `${options.runtimeRoot}/${spec.runId}.runtime`;
      const name = `helmsman-${spec.runId}`;
      let existing: unknown;
      try {
        const inspected = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', name]);
        if (inspected.code !== 0) throw new Error('Could not inspect the existing Docker run');
        existing = JSON.parse(inspected.stdout);
      } catch (error) {
        const message = String((error as { stderr?: unknown })?.stderr ?? (error instanceof Error ? error.message : error));
        if (!/No such (?:object|container)/i.test(message)) throw error;
      }
      if (existing !== undefined) {
        const container = existing as { Id?: unknown; State?: { Running?: unknown; Status?: unknown }; Config?: { Labels?: Record<string, unknown> } } | null;
        if (!container || typeof container.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(container.Id)
          || container.Config?.Labels?.['helmsman.runId'] !== spec.runId || typeof container.State?.Running !== 'boolean') {
          throw new Error('Existing Docker container does not belong to this run');
        }
        if (container.State.Running) return { kind: 'docker', containerId: container.Id };
        if (!['created', 'exited', 'dead'].includes(String(container.State.Status))) throw new Error('Existing Docker container is not stopped');
        const removed = await run(['docker', 'rm', container.Id]);
        if (removed.code !== 0) throw new Error('Could not reclaim the stopped Docker run');
      }
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const staged = { ...spec, cwd: '/worktree', logPath: '/runtime/worker.log', exitPath: '/runtime/worker.exit', specPath: '/runtime/spec.json' };
      await writeFile(spec.specPath, JSON.stringify(spec), { mode: 0o600 });
      await copyFile(options.wrapperPath, join(runtime, 'run-wrapper.mjs'));
      await writeFile(join(runtime, 'spec.json'), JSON.stringify(staged), { mode: 0o600 });
      await writeFile(join(runtime, 'worker.log'), '', { mode: 0o600 });
      await rm(join(runtime, 'worker.exit'), { force: true });
      await link(spec.logPath, join(runtime, 'worker.log'));
      await link(spec.exitPath, join(runtime, 'worker.exit'));
      const result = await run(['docker', 'run', '--detach', '--name', name, '--label', `helmsman.runId=${spec.runId}`, '--workdir', '/worktree',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--mount', `type=bind,src=${spec.cwd},dst=/worktree`, '--mount', `type=bind,src=${runtime},dst=/runtime`,
        '--env', 'HELMSMAN_RUNTIME=/runtime', '--network', 'none', '--entrypoint', 'node', options.image, '/runtime/run-wrapper.mjs', '/runtime/spec.json']);
      const containerId = result.stdout.trim();
      if (!/^[a-f\d]{12,64}$/i.test(containerId)) throw new Error('Docker returned an invalid container identity');
      return { kind: 'docker', containerId };
    },
    async isAlive(ref) {
      if (ref.kind !== 'docker') return false;
      try { const result = await run(['docker', 'inspect', '--format', '{{.State.Running}}', ref.containerId]); return result.stdout.trim() === 'true'; } catch { return false; }
    },
    async stop(ref) { if (ref.kind === 'docker') try { await run(['docker', 'stop', '--time', '10', ref.containerId]); } catch {} },
  };
}

export async function hasDocker(run: DockerRun = dockerRun): Promise<boolean> { try { return (await run(['docker', 'version', '--format', '{{.Server.Version}}'])).code === 0; } catch { return false; } }
