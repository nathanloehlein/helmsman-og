import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detachedHost, cmuxHost, pickHost, parseCmuxWorkspaceRef, type LaunchSpec } from './run-host';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

function spec(dir: string, cmd: string, args: string[]): LaunchSpec {
  return { runId: 'r1', cmd, args, cwd: dir, logPath: join(dir, 'run.log'), exitPath: join(dir, 'run.exit'), specPath: join(dir, 'r1.json') };
}

describe('detachedHost', () => {
  it('launches the wrapper, reports liveness, and finishes with an exit file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-'));
    const host = detachedHost(WRAPPER);
    const ref = await host.launch(spec(dir, 'node', ['-e', 'setTimeout(()=>process.exit(3), 300)']));
    expect(ref.kind).toBe('detached');
    expect(await host.isAlive(ref)).toBe(true);
    // Spawns a detached wrapper which spawns node, which exits after 300ms and
    // only then writes the exit file. Under full-suite load on Windows that
    // chain can outlast a 3s budget, so wait long enough that a failure here
    // means the file is never written rather than merely late.
    await vi.waitFor(() => expect(existsSync(join(dir, 'run.exit'))).toBe(true), { timeout: 30_000 });
    expect(readFileSync(join(dir, 'run.exit'), 'utf8').trim()).toBe('3');
  });
});

describe('parseCmuxWorkspaceRef', () => {
  it('parses the confirmed "OK workspace:N" stdout shape', () => {
    expect(parseCmuxWorkspaceRef('OK workspace:5\n')).toBe('workspace:5');
    expect(parseCmuxWorkspaceRef('OK workspace:12')).toBe('workspace:12');
  });

  it('throws when no workspace ref is present', () => {
    expect(() => parseCmuxWorkspaceRef('some unrelated output')).toThrow();
  });
});

describe('cmuxHost argv', () => {
  it('builds a new-workspace command that runs the wrapper, no untrusted shell data', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return { stdout: 'OK workspace:7', code: 0 }; };
    const host = cmuxHost(WRAPPER, run);
    const dir = mkdtempSync(join(tmpdir(), 'host-'));
    const ref = await host.launch(spec(dir, 'codex', ['exec', 'title with spaces']));
    expect(ref).toEqual({ kind: 'cmux', workspace: 'workspace:7' });
    const argv = calls[0]!;
    expect(argv[0]).toBe('cmux');
    expect(argv).toContain('new-workspace');
    expect(argv).toContain('--command');
    const cmd = argv[argv.indexOf('--command') + 1]!;
    expect(cmd).toBe(`node ${WRAPPER} ${join(dir, 'r1.json')}`); // only the spec path, never the title
    expect(cmd).not.toContain('title with spaces');
    expect(argv).toContain('--focus');
    expect(argv[argv.indexOf('--focus') + 1]).toBe('false');
  });

  it('reports liveness by checking list-workspaces output for the ref', async () => {
    const run = async (argv: string[]) => {
      if (argv.includes('list-workspaces')) return { stdout: '  workspace:7  run-r1\n  workspace:2  other\n', code: 0 };
      return { stdout: 'OK workspace:7', code: 0 };
    };
    const host = cmuxHost(WRAPPER, run);
    expect(await host.isAlive({ kind: 'cmux', workspace: 'workspace:7' })).toBe(true);
    expect(await host.isAlive({ kind: 'cmux', workspace: 'workspace:99' })).toBe(false);
  });

  it('stops via close-workspace', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return { stdout: 'OK workspace:7', code: 0 }; };
    const host = cmuxHost(WRAPPER, run);
    await host.stop({ kind: 'cmux', workspace: 'workspace:7' });
    expect(calls[0]).toEqual(['cmux', 'close-workspace', '--workspace', 'workspace:7']);
  });

  it('swallows errors from stop', async () => {
    const run = async () => { throw new Error('socket down'); };
    const host = cmuxHost(WRAPPER, run);
    await expect(host.stop({ kind: 'cmux', workspace: 'workspace:7' })).resolves.toBeUndefined();
  });
});

describe('pickHost', () => {
  it('uses cmux only when explicitly opted in and cmux is present', async () => {
    expect((await pickHost({ preferCmux: true, hasCmux: async () => true, wrapperPath: WRAPPER })).kind).toBe('cmux');
  });

  it('defaults to detached when not opted into cmux, even if cmux is present', async () => {
    expect((await pickHost({ preferCmux: false, hasCmux: async () => true, wrapperPath: WRAPPER })).kind).toBe('detached');
  });

  it('falls back to detached when opted in but cmux is unavailable', async () => {
    expect((await pickHost({ preferCmux: true, hasCmux: async () => false, wrapperPath: WRAPPER })).kind).toBe('detached');
  });
});
