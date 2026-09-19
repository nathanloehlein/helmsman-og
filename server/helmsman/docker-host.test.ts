// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerHost, type DockerRun } from './docker-host';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = 'a'.repeat(64);
const missing = Object.assign(new Error('Docker inspect failed'), { stderr: 'Error: No such object: helmsman-run_1' });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docker-host-'));
  roots.push(root);
  const wrapper = join(root, 'wrapper.mjs');
  writeFileSync(wrapper, '');
  const run = vi.fn<DockerRun>().mockRejectedValueOnce(missing).mockResolvedValue({ stdout: id, code: 0 });
  const host = dockerHost({ image: 'helmsman:test', runtimeRoot: root, wrapperPath: wrapper, run, enabled: true });
  const spec = { runId: 'run_1', cmd: 'node', args: ['worker'], cwd: '/worktree/run_1',
    logPath: join(root, 'host.log'), exitPath: join(root, 'host.exit'), specPath: join(root, 'host.json') };
  return { root, run, host, spec, wrapper };
}
const inspected = (running: boolean, label: string = 'run_1', status = running ? 'running' : 'exited') => ({ stdout: JSON.stringify({ Id: id,
  State: { Running: running, Status: status }, Config: { Labels: { 'helmsman.runId': label } } }), code: 0 });

describe('docker host', () => {
  it.each(['pre-pr-cli.ts', 'docker-review-cli.ts'])('rejects host-only %s coordinators before Docker or filesystem effects', async filename => {
    const { run, host, spec } = fixture();
    await expect(host.launch({ ...spec, args: ['--import', 'tsx', `/app/server/helmsman/${filename}`, '{}'] })).rejects.toThrow('must execute on the host');
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(spec.specPath)).toBe(false);
  });

  it('uses only per-run mounts and persists a container ref', async () => {
    const { root, run, host, spec } = fixture();
    await expect(host.launch(spec)).resolves.toEqual({ kind: 'docker', containerId: id });
    expect(run.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(['--network', 'none', 'node', '/runtime/run-wrapper.mjs', '/runtime/spec.json']));
    expect(JSON.parse(readFileSync(join(root, 'run_1.runtime', 'spec.json'), 'utf8')))
      .toMatchObject({ cwd: '/worktree', logPath: '/runtime/worker.log', exitPath: '/runtime/worker.exit' });
    writeFileSync(join(root, 'run_1.runtime', 'worker.log'), 'output');
    writeFileSync(join(root, 'run_1.runtime', 'worker.exit'), '0');
    expect(readFileSync(spec.logPath, 'utf8')).toBe('output');
    expect(readFileSync(spec.exitPath, 'utf8')).toBe('0');
    expect(JSON.parse(readFileSync(spec.specPath, 'utf8'))).toMatchObject({ cwd: spec.cwd });
  });

  it('returns an existing matching live container without rewriting logs or launch state', async () => {
    const { run, host, spec } = fixture();
    run.mockReset().mockResolvedValue(inspected(true));
    writeFileSync(spec.logPath, 'live output');
    writeFileSync(spec.exitPath, 'preserved marker');
    writeFileSync(spec.specPath, 'original spec');
    await expect(host.launch(spec)).resolves.toEqual({ kind: 'docker', containerId: id });
    expect(run).toHaveBeenCalledTimes(1);
    expect(readFileSync(spec.logPath, 'utf8')).toBe('live output');
    expect(readFileSync(spec.exitPath, 'utf8')).toBe('preserved marker');
    expect(readFileSync(spec.specPath, 'utf8')).toBe('original spec');
  });

  it('reclaims only a matching stopped container and clears stale attempt files', async () => {
    const { root, run, host, spec } = fixture();
    run.mockReset().mockResolvedValueOnce(inspected(false)).mockResolvedValue({ stdout: id, code: 0 });
    mkdirSync(join(root, 'run_1.runtime'));
    writeFileSync(join(root, 'run_1.runtime', 'worker.log'), 'old output');
    writeFileSync(join(root, 'run_1.runtime', 'worker.exit'), '0');
    await expect(host.launch(spec)).resolves.toEqual({ kind: 'docker', containerId: id });
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['inspect', 'rm', 'run']);
    expect(run.mock.calls[1]?.[0]).toEqual(['docker', 'rm', id]);
    expect(readFileSync(spec.logPath, 'utf8')).toBe('');
    expect(existsSync(join(root, 'run_1.runtime', 'worker.exit'))).toBe(false);
  });

  it.each([inspected(false, 'another-run'), inspected(false, 'run_1', 'restarting'), { stdout: '{}', code: 0 }])
    ('leaves an unowned or transitional container and its files untouched', async result => {
      const { run, host, spec } = fixture();
      run.mockReset().mockResolvedValue(result);
      writeFileSync(spec.logPath, 'preserve');
      await expect(host.launch(spec)).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
      expect(readFileSync(spec.logPath, 'utf8')).toBe('preserve');
    });

  it('does not reset output if stopped-container removal fails or races with restart', async () => {
    const { run, host, spec } = fixture();
    run.mockReset().mockResolvedValueOnce(inspected(false)).mockRejectedValueOnce(new Error('Container is running'));
    writeFileSync(spec.logPath, 'preserve');
    await expect(host.launch(spec)).rejects.toThrow('running');
    expect(readFileSync(spec.logPath, 'utf8')).toBe('preserve');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not mistake Docker daemon errors for a missing run', async () => {
    const { run, host, spec } = fixture();
    run.mockReset().mockRejectedValue(new Error('Docker daemon unavailable'));
    await expect(host.launch(spec)).rejects.toThrow('unavailable');
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(spec.specPath)).toBe(false);
  });

  it('reattaches by container id and stops an active container', async () => {
    const { run, host } = fixture();
    run.mockReset().mockResolvedValueOnce({ stdout: 'true\n', code: 0 }).mockResolvedValueOnce({ stdout: '', code: 0 });
    expect(await host.isAlive({ kind: 'docker', containerId: id })).toBe(true);
    await host.stop({ kind: 'docker', containerId: id });
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(['inspect', 'stop']);
  });

  it('is disabled unless explicitly enabled', async () => {
    const { root, wrapper, run, spec } = fixture();
    const host = dockerHost({ image: 'x', runtimeRoot: root, wrapperPath: wrapper, run, enabled: false });
    await expect(host.launch(spec)).rejects.toThrow('disabled');
    expect(run).not.toHaveBeenCalled();
  });
});
