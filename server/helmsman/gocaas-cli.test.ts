// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), goCaasKey: vi.fn(), goCaasLaunch: vi.fn(), goCodePath: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./gocaas', () => ({ goCaasKey: mocks.goCaasKey, goCaasLaunch: mocks.goCaasLaunch, goCodePath: mocks.goCodePath }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let child: EventEmitter;
let stderr: ReturnType<typeof vi.spyOn>;
let signalListeners: Map<NodeJS.Signals, Set<unknown>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  child = new EventEmitter();
  mocks.spawn.mockReturnValue(child);
  mocks.goCaasKey.mockResolvedValue('secret-token');
  mocks.goCodePath.mockReturnValue('/fake/gocode');
  mocks.goCaasLaunch.mockReturnValue({ cmd: 'codex', args: ['secret-prompt'], env: { TOKEN: 'secret-token' } });
  process.argv = ['node', 'gocaas-cli.ts', 'codex', '["secret-prompt"]'];
  process.exitCode = undefined;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  signalListeners = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal as NodeJS.Signals, new Set(process.listeners(signal))]));
});

afterEach(() => {
  for (const [signal, original] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!original.has(listener)) process.removeListener(signal, listener);
    }
  }
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('GoCaaS agent failure diagnostics', () => {
  it.each([
    [7, null, 'exited with code 7', 7],
    [null, 'SIGTERM', 'terminated by signal SIGTERM', 1],
  ])('reports child exit %s / %s without invocation secrets', async (code, signal, diagnostic, expectedExitCode) => {
    await import('./gocaas-cli');
    child.emit('exit', code, signal);
    expect(stderr).toHaveBeenCalledWith(`\nGoCaaS codex agent ${diagnostic}\n`);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret');
    expect(process.exitCode).toBe(expectedExitCode);
  });

  it('reports the spawn error code without copying potentially sensitive error details', async () => {
    await import('./gocaas-cli');
    child.emit('error', Object.assign(new Error('secret-prompt secret-token'), { code: 'ENOENT' }));
    expect(stderr).toHaveBeenCalledWith('Could not start the GoCaaS codex agent (ENOENT).\n');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret');
    expect(process.exitCode).toBe(1);
  });

  it('does not report successful exits as failures', async () => {
    await import('./gocaas-cli');
    child.emit('exit', 0, null);
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});
