import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentTask } from './agents/adapter';

const exec = promisify(execFile);
const LIMIT = 256 * 1024;

export async function sanitizeDockerGit(cwd: string, repo: string): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid Docker repository');
  const gitDir = join(cwd, '.git');
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('Unsafe Docker Git metadata');
    if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
  };
  if (!(await lstat(gitDir)).isDirectory()) throw new Error('Docker Git directory was replaced');
  await inspect(gitDir);
  for (const name of ['alternates', 'http-alternates']) {
    if (await lstat(join(gitDir, 'objects', 'info', name)).catch(() => null)) throw new Error('Docker Git object alternates are not allowed');
  }
  const file = await open(join(gitDir, 'config'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\nfsmonitor = false\nsshCommand = false\n[remote "origin"]\nurl = https://github.com/${repo}.git\nfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  } finally { await file.close(); }
}

async function boundedFile(path: string, missing = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (missing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return Buffer.alloc(0);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Docker stage output must be a bounded regular file');
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LIMIT) throw new Error('Docker stage output exceeded its limit');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export interface DockerStage {
  command: { cmd: string; args: string[] };
  cleanup(success: boolean): Promise<void>;
  stop(): Promise<void>;
}

export async function prepareDockerStage(adapter: AgentAdapter, task: AgentTask, cwd: string,
  control: (args: string[]) => Promise<void> = async args => { await exec('docker', args, { timeout: 15_000 }); }): Promise<DockerStage> {
  const config = task.dockerExecution;
  if (!config || !/^[a-z\d_-]{1,128}$/i.test(config.runId) || !/^[a-f\d]{64}$/i.test(config.capability)
    || !/^[a-z\d][a-z\d./_:@-]{0,255}$/i.test(config.image) || !task.prePr?.reportPath && task.review !== true) throw new Error('Invalid Docker stage configuration');
  const gateway = new URL(config.gatewayUrl);
  if (gateway.protocol !== 'http:' || gateway.hostname !== 'host.docker.internal' || gateway.username || gateway.password
    || gateway.search || gateway.hash || gateway.pathname !== '/') throw new Error('Invalid Docker stage gateway');
  if (!(await lstat(join(cwd, '.git'))).isDirectory()) throw new Error('Docker stage requires a standalone Git clone');
  const root = resolve(config.runtimeRoot ?? tmpdir());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(root, 'helmsman-stage-'));
  const name = `helmsman-stage-${config.runId.slice(0, 80)}-${randomUUID()}`;
  const relayName = `${name}-relay`;
  const network = `${name}-network`;
  const isolatedGateway = 'http://gateway:8080';
  let timer: ReturnType<typeof setInterval> | undefined;
  let relay: Promise<void> = Promise.resolve();
  let relayError: unknown;
  let questionBytes = 0;
  const stop = async () => {
    try { await control(['rm', '--force', name]); }
    catch (error) { if (!/No such container/i.test(String((error as { stderr?: unknown })?.stderr ?? error))) throw error; }
  };
  const teardownNetwork = async () => {
    try { await control(['rm', '--force', relayName]); }
    catch (error) { if (!/No such container/i.test(String((error as { stderr?: unknown })?.stderr ?? error))) throw error; }
    try { await control(['network', 'rm', network]); }
    catch (error) { if (!/No such network|network .* not found/i.test(String((error as { stderr?: unknown })?.stderr ?? error))) throw error; }
  };
  try {
    await mkdir(join(runtime, 'home'), { mode: 0o700 });
    await mkdir(join(runtime, 'codex-home'), { mode: 0o700 });
    await writeFile(join(runtime, 'codex-home', 'config.toml'), `model_provider = "helmsman"\n[model_providers.helmsman]\nname = "Helmsman"\nbase_url = ${JSON.stringify(`${isolatedGateway}/openai/v1`)}\nenv_key = "HELMSMAN_CAPABILITY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
    const mapped: AgentTask = { ...task, dockerExecution: undefined,
      skillsPath: task.skillsPath ? '/skills' : undefined,
      reviewOutputPaths: task.review ? { markdown: '/runtime/review.md', comments: '/runtime/review-comments.json' } : undefined,
      prePr: task.prePr ? { ...task.prePr, reportPath: '/runtime/report.json',
        ...(task.prePr.summaryCorrection ? { summaryCorrection: { ...task.prePr.summaryCorrection, reportPath: '/runtime/prior-report.json' } } : {}) } : undefined,
      clarification: task.clarification ? { questionsPath: '/runtime/questions.jsonl', answersPath: '/runtime/answers.jsonl' } : undefined };
    if (task.prePr?.summaryCorrection) await copyFile(task.prePr.summaryCorrection.reportPath, join(runtime, 'prior-report.json'));
    const syncClarification = async () => {
      if (!task.clarification) return;
      const questions = await boundedFile(join(runtime, 'questions.jsonl'), true);
      if (questions.length < questionBytes) throw new Error('Docker clarification log was truncated');
      if (questions.length > questionBytes) {
        const handle = await open(task.clarification.questionsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(questions.subarray(questionBytes)); } finally { await handle.close(); }
        questionBytes = questions.length;
      }
      const answers = await boundedFile(task.clarification.answersPath, true);
      const handle = await open(join(runtime, 'answers.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(answers); } finally { await handle.close(); }
    };
    await syncClarification();
    if (task.clarification) timer = setInterval(() => {
      relay = relay.then(syncClarification).catch(error => { relayError = error; void stop().catch(() => undefined); });
    }, 500);
    const child = adapter.buildCommand(mapped);
    const mount = (source: string, target: string, readOnly = false) => {
      if (source.includes(',') || /[\r\n]/.test(source)) throw new Error('Unsupported Docker mount path');
      return `type=bind,src=${resolve(source)},dst=${target}${readOnly ? ',readonly' : ''}`;
    };
    const args = ['run', '--rm', '--name', name, '--label', `helmsman.runId=${config.runId}`,
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--workdir', '/worktree', '--network', network,
      '--mount', mount(cwd, '/worktree', task.review || task.prePr?.stage === 'review'), '--mount', mount(runtime, '/runtime'),
      ...(task.skillsPath ? ['--mount', mount(join(task.skillsPath, 'skills'), '/skills/skills', true)] : []),
      '--env', 'HOME=/runtime/home', '--env', 'CODEX_HOME=/runtime/codex-home',
      '--env', 'GIT_AUTHOR_NAME=Helmsman', '--env', 'GIT_AUTHOR_EMAIL=helmsman@localhost',
      '--env', 'GIT_COMMITTER_NAME=Helmsman', '--env', 'GIT_COMMITTER_EMAIL=helmsman@localhost',
      '--env', `HELMSMAN_CAPABILITY=${config.capability}`, '--env', `ANTHROPIC_API_KEY=${config.capability}`,
      '--env', `ANTHROPIC_BASE_URL=${isolatedGateway}/anthropic`, '--env', `HELMSMAN_GATEWAY_URL=${isolatedGateway}`,
      '--env', `HELMSMAN_REPO=${task.repo}`,
      '--entrypoint', child.cmd, config.image, ...child.args];
    await control(['network', 'create', '--internal', '--label', `helmsman.runId=${config.runId}`, network]);
    const relaySource = await readFile(fileURLToPath(new URL('./docker-gateway-relay.mjs', import.meta.url)), 'utf8');
    await control(['create', '--name', relayName, '--label', `helmsman.runId=${config.runId}`, '--network', 'bridge',
      '--add-host', 'host.docker.internal:host-gateway', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--entrypoint', 'node', config.image, '-e', relaySource, gateway.origin, '8080']);
    await control(['network', 'connect', '--alias', 'gateway', network, relayName]);
    await control(['start', relayName]);
    await control(['exec', relayName, 'node', '-e', "(async()=>{for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:8080/health')).status===204)return;}catch{}await new Promise(r=>setTimeout(r,100));}process.exitCode=1;})()"]);
    return { command: { cmd: 'docker', args }, stop,
      async cleanup(success) {
        if (timer) clearInterval(timer);
        await stop();
        await teardownNetwork();
        try {
          await sanitizeDockerGit(cwd, task.repo);
          await relay;
          if (relayError) throw relayError;
          await syncClarification();
          if (success && task.review) {
            const markdown = await boundedFile(join(runtime, 'review.md'));
            const comments = await boundedFile(join(runtime, 'review-comments.json'));
            if (!markdown.toString('utf8').trim() || !Array.isArray(JSON.parse(comments.toString('utf8')))) throw new Error('Docker review output is incomplete');
            for (const [path, bytes] of [['.agent-review.md', markdown], ['.agent-review-comments.json', comments]] as const) {
              const file = await open(join(cwd, path), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
              try { await file.writeFile(bytes); } finally { await file.close(); }
            }
          } else if (success && task.prePr) await writeFile(task.prePr.reportPath, await boundedFile(join(runtime, 'report.json')), { mode: 0o600 });
        } finally { await rm(runtime, { recursive: true, force: true }); }
      } };
  } catch (error) {
    if (timer) clearInterval(timer);
    await stop();
    await teardownNetwork();
    await rm(runtime, { recursive: true, force: true });
    throw error;
  }
}
