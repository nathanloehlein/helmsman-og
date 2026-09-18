import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detachedHost, cmuxHost, weztermHost, pickHost, parseCmuxWorkspaceRef, parseWezPaneId, type LaunchSpec } from './run-host';

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
    await vi.waitFor(() => expect(existsSync(join(dir, 'run.exit'))).toBe(true), { timeout: 3000 });
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

describe('parseWezPaneId', () => {
  it('parses the pane id wezterm cli spawn prints', () => {
    expect(parseWezPaneId('7\n')).toBe('7');
    expect(parseWezPaneId('0')).toBe('0');
  });

  it('throws when no pane id is present', () => {
    expect(() => parseWezPaneId('some unrelated output')).toThrow();
  });
});

describe('weztermHost argv', () => {
  it('spawns the wrapper into its own window and workspace, no untrusted shell data', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return { stdout: '7\n', code: 0 }; };
    const dir = mkdtempSync(join(tmpdir(), 'host-'));
    const ref = await weztermHost(WRAPPER, run).launch(spec(dir, 'codex', ['exec', 'title with spaces']));
    expect(ref).toEqual({ kind: 'wezterm', paneId: '7' });
    const argv = calls[0]!;
    expect(argv.slice(0, 3)).toEqual(['wezterm', 'cli', 'spawn']);
    // --workspace is only honoured alongside --new-window
    expect(argv).toContain('--new-window');
    expect(argv[argv.indexOf('--workspace') + 1]).toBe('helmsman-runs');
    // the program is passed as argv after --, never as a shell string
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'node', WRAPPER, join(dir, 'r1.json')]);
    expect(argv.join(' ')).not.toContain('title with spaces');
  });

  it('reports liveness by looking for the pane in the list', async () => {
    const run = async () => ({ stdout: JSON.stringify([{ pane_id: 7 }, { pane_id: 2 }]), code: 0 });
    const host = weztermHost(WRAPPER, run);
    expect(await host.isAlive({ kind: 'wezterm', paneId: '7' })).toBe(true);
    expect(await host.isAlive({ kind: 'wezterm', paneId: '99' })).toBe(false);
  });

  it('stops via kill-pane', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return { stdout: '', code: 0 }; };
    await weztermHost(WRAPPER, run).stop({ kind: 'wezterm', paneId: '7' });
    expect(calls[0]).toEqual(['wezterm', 'cli', 'kill-pane', '--pane-id', '7']);
  });

  it('swallows errors from stop', async () => {
    const run = async () => { throw new Error('socket down'); };
    await expect(weztermHost(WRAPPER, run).stop({ kind: 'wezterm', paneId: '7' })).resolves.toBeUndefined();
  });

  it('ignores a ref belonging to another host', async () => {
    const run = async () => { throw new Error('should not run'); };
    expect(await weztermHost(WRAPPER, run).isAlive({ kind: 'detached', pid: 1 })).toBe(false);
  });
});

describe('pickHost', () => {
  const both = { hasCmux: async () => true, hasWezTerm: async () => true, wrapperPath: WRAPPER };

  it('uses cmux only when explicitly opted in and cmux is present', async () => {
    expect((await pickHost({ ...both, prefer: 'cmux' })).kind).toBe('cmux');
  });

  it('uses wezterm only when explicitly opted in and wezterm is present', async () => {
    expect((await pickHost({ ...both, prefer: 'wezterm' })).kind).toBe('wezterm');
  });

  it('defaults to detached when not opted in, even if both are present', async () => {
    expect((await pickHost({ ...both, prefer: null })).kind).toBe('detached');
    expect((await pickHost({ ...both, prefer: 'detached' })).kind).toBe('detached');
  });

  it('falls back to detached when opted in but the terminal is unavailable', async () => {
    expect((await pickHost({ ...both, hasCmux: async () => false, prefer: 'cmux' })).kind).toBe('detached');
    expect((await pickHost({ ...both, hasWezTerm: async () => false, prefer: 'wezterm' })).kind).toBe('detached');
  });

  it('never probes the terminal it was not asked for', async () => {
    const boom = async (): Promise<boolean> => { throw new Error('probed'); };
    expect((await pickHost({ ...both, hasWezTerm: boom, prefer: 'cmux' })).kind).toBe('cmux');
    expect((await pickHost({ ...both, hasCmux: boom, prefer: 'wezterm' })).kind).toBe('wezterm');
  });
});
