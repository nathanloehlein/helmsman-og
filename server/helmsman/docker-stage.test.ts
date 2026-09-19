// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import { prepareDockerStage, sanitizeDockerGit } from './docker-stage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-docker-stage-test-'));
  roots.push(root);
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await writeFile(join(cwd, '.git', 'config'), '[core]\nfsmonitor = /evil\n');
  const task: AgentTask = { ticketId: 'T-1', title: 'Task', repo: 'org/repo', jiraBaseUrl: '',
    prePr: { stage: 'implement', baseSha: 'a'.repeat(40), reportPath: join(root, 'report.json'), round: 0 },
    dockerExecution: { image: 'helmsman:test', runId: 'run-1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'a'.repeat(64), runtimeRoot: root } };
  const buildCommand = vi.fn<AgentAdapter['buildCommand']>(() => ({ cmd: 'codex', args: ['exec', 'test prompt'] }));
  const adapter: AgentAdapter = { id: 'codex', buildCommand, parseLine: () => null };
  const control = vi.fn<(args: string[]) => Promise<void>>().mockResolvedValue(undefined);
  return { root, cwd, task, adapter, buildCommand, control };
}
function runtime(args: string[]): string {
  const mount = args.find(arg => arg.endsWith('dst=/runtime'));
  const source = mount?.match(/src=([^,]+)/)?.[1];
  if (!source) throw new Error('No runtime mount');
  return source;
}

describe('Docker agent stages', () => {
  it('mounts only the clone, stage output and readonly skills and uses scoped provider credentials', async () => {
    const env = await fixture();
    env.task.skillsPath = join(env.root, 'skills');
    await mkdir(join(env.task.skillsPath, 'skills'), { recursive: true });
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    const args = stage.command.args;
    expect(stage.command.cmd).toBe('docker');
    expect(args).toContain('helmsman.runId=run-1');
    expect(args.filter(arg => arg.startsWith('type=bind,'))).toHaveLength(3);
    expect(args).toContain(`type=bind,src=${env.task.skillsPath}/skills,dst=/skills/skills,readonly`);
    expect(args).toContain(`HELMSMAN_CAPABILITY=${'a'.repeat(64)}`);
    expect(args).toContain('HELMSMAN_REPO=org/repo');
    expect(args).toContain(`type=bind,src=${env.cwd},dst=/worktree`);
    expect(args).not.toContain('--add-host');
    expect(args).toContain('HELMSMAN_GATEWAY_URL=http://gateway:8080');
    expect(env.control).toHaveBeenCalledWith(['network', 'create', '--internal', '--label', 'helmsman.runId=run-1', expect.any(String)]);
    const relay = env.control.mock.calls.find(([call]) => call[0] === 'create')?.[0];
    expect(relay).toContain('--read-only');
    expect(relay).not.toContain('--mount');
    expect(relay).not.toContain('--env');
    expect(args).not.toContain('OPENAI_API_KEY');
    expect(args).not.toContain('/var/run/docker.sock');
    expect(env.buildCommand.mock.calls[0]?.[0]).toMatchObject({ skillsPath: '/skills', prePr: { reportPath: '/runtime/report.json' } });
    const config = await readFile(join(runtime(args), 'codex-home', 'config.toml'), 'utf8');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('env_key = "HELMSMAN_CAPABILITY"');
    expect(config).toContain('http://gateway:8080/openai/v1');
    await writeFile(join(runtime(args), 'report.json'), '{"title":"T-1"}');
    await stage.cleanup(true);
    expect(await readFile(env.task.prePr!.reportPath, 'utf8')).toBe('{"title":"T-1"}');
    expect(env.control).toHaveBeenCalledWith(['rm', '--force', expect.stringMatching(/^helmsman-stage-run-1-/)]);
    const gitConfig = await readFile(join(env.cwd, '.git', 'config'), 'utf8');
    expect(gitConfig).not.toContain('/evil');
    expect(gitConfig).toContain('https://github.com/org/repo.git');
  });

  it('mounts review clones read-only and refuses linked worktrees', async () => {
    const env = await fixture();
    env.task.prePr!.stage = 'review';
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    expect(stage.command.args).toContain(`type=bind,src=${env.cwd},dst=/worktree,readonly`);
    await stage.cleanup(false);
    await rm(join(env.cwd, '.git'), { recursive: true });
    await writeFile(join(env.cwd, '.git'), 'gitdir: /outside');
    await expect(prepareDockerStage(env.adapter, env.task, env.cwd, env.control)).rejects.toThrow('standalone');
  });

  it('rejects a report symlink before reading host files', async () => {
    const env = await fixture();
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    await symlink(join(env.cwd, '.git', 'config'), join(runtime(stage.command.args), 'report.json'));
    await expect(stage.cleanup(true)).rejects.toThrow();
    await expect(readFile(env.task.prePr!.reportPath)).rejects.toThrow();
  });

  it('maps standalone review outputs outside the read-only repository and copies validated results', async () => {
    const env = await fixture();
    env.task.review = true;
    env.task.prePr = undefined;
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    const dir = runtime(stage.command.args);
    expect(stage.command.args).toContain(`type=bind,src=${env.cwd},dst=/worktree,readonly`);
    expect(env.buildCommand.mock.calls[0]?.[0]).toMatchObject({ prePr: undefined,
      reviewOutputPaths: { markdown: '/runtime/review.md', comments: '/runtime/review-comments.json' } });
    await writeFile(join(dir, 'review.md'), 'Verdict: APPROVE — checked');
    await writeFile(join(dir, 'review-comments.json'), '[]');
    await stage.cleanup(true);
    expect(await readFile(join(env.cwd, '.agent-review.md'), 'utf8')).toBe('Verdict: APPROVE — checked');
    expect(await readFile(join(env.cwd, '.agent-review-comments.json'), 'utf8')).toBe('[]');
  });

  it('does not copy incomplete standalone review output', async () => {
    const env = await fixture();
    env.task.review = true;
    env.task.prePr = undefined;
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    const dir = runtime(stage.command.args);
    await writeFile(join(dir, 'review.md'), 'Verdict: APPROVE — checked');
    await writeFile(join(dir, 'review-comments.json'), '{}');
    await expect(stage.cleanup(true)).rejects.toThrow('incomplete');
    await expect(readFile(join(env.cwd, '.agent-review.md'))).rejects.toThrow();
  });

  it('relays clarification questions and rejects guest answer-file symlinks', async () => {
    const env = await fixture();
    env.task.clarification = { questionsPath: join(env.root, 'questions'), answersPath: join(env.root, 'answers') };
    await writeFile(env.task.clarification.answersPath, 'answer\n');
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    const dir = runtime(stage.command.args);
    expect(await readFile(join(dir, 'answers.jsonl'), 'utf8')).toBe('answer\n');
    await writeFile(join(dir, 'questions.jsonl'), '{"id":"q1"}\n');
    await rm(join(dir, 'answers.jsonl'));
    await symlink(env.task.clarification.answersPath, join(dir, 'answers.jsonl'));
    await expect(stage.cleanup(false)).rejects.toThrow();
    expect(await readFile(env.task.clarification.questionsPath, 'utf8')).toBe('{"id":"q1"}\n');
    expect(await readFile(env.task.clarification.answersPath, 'utf8')).toBe('answer\n');
  });

  it('does not trust outputs if container removal fails', async () => {
    const env = await fixture();
    const stage = await prepareDockerStage(env.adapter, env.task, env.cwd, env.control);
    env.control.mockRejectedValue(new Error('Docker daemon unavailable'));
    await expect(stage.cleanup(true)).rejects.toThrow('Docker daemon unavailable');
    await expect(readFile(env.task.prePr!.reportPath)).rejects.toThrow();
  });

  it('rejects Git metadata symlinks and alternate object stores', async () => {
    const env = await fixture();
    await symlink(env.root, join(env.cwd, '.git', 'hooks'));
    await expect(sanitizeDockerGit(env.cwd, 'org/repo')).rejects.toThrow('Unsafe');
    await rm(join(env.cwd, '.git', 'hooks'));
    await mkdir(join(env.cwd, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(env.cwd, '.git', 'objects', 'info', 'alternates'), '/secret');
    await expect(sanitizeDockerGit(env.cwd, 'org/repo')).rejects.toThrow('alternates');
  });
});
