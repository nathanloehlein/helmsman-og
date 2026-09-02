import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge, type RunCmux, type SpawnEventsChild } from './bridge';

vi.mock('node:child_process', () => {
  const spawn = vi.fn();
  return { spawn, default: { spawn } };
});

describe('bridge.send', () => {
  it('passes user text as a single argv element (no shell)', async () => {
    const calls: string[][] = [];
    const bridge = createBridge((args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await bridge.send('surface:1', 'rm -rf $(pwd); echo pwned', false);
    expect(calls).toEqual([['send', '--surface', 'surface:1', 'rm -rf $(pwd); echo pwned']]);
  });

  it('sends Enter as a separate send-key call when enter=true', async () => {
    const calls: string[][] = [];
    const bridge = createBridge((args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await bridge.send('surface:1', 'ls', true);
    expect(calls).toEqual([
      ['send', '--surface', 'surface:1', 'ls'],
      ['send-key', '--surface', 'surface:1', 'Enter'],
    ]);
  });
});

describe('bridge.listTabs', () => {
  it('reports not connected when cmux errors', async () => {
    const bridge = createBridge(() => Promise.reject(new Error('ENOENT: cmux')));
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('joins workspace + surface JSON into tabs', async () => {
    const run: RunCmux = (args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            window_ref: 'window:1',
            workspaces: [{ ref: 'workspace:1', title: 'ws', current_directory: '/repo' }],
          }),
        });
      }
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          workspace_ref: 'workspace:1',
          window_ref: 'window:1',
          surfaces: [{ ref: 'surface:1', title: 'ws', type: 'terminal', selected: true }],
        }),
      });
    };
    const res = await createBridge(run).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0].surfaceRef).toBe('surface:1');
    expect(res.tabs[0].cwd).toBe('/repo');
  });

  it('aggregates tabs across every window, not just the focused one', async () => {
    const run: RunCmux = (args) => {
      if (args[0] === 'list-windows') {
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify([
            { id: 'win-a', index: 0 },
            { id: 'win-b', index: 1 },
          ]),
        });
      }
      if (args[0] === 'workspace' && args[1] === 'list') {
        const windowId = args[args.indexOf('--window') + 1];
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            window_ref: `window:${windowId}`,
            workspaces: [{ ref: `workspace:${windowId}`, title: 'ws', current_directory: '/repo' }],
          }),
        });
      }
      if (args[0] === 'list-pane-surfaces') {
        const workspaceRef = args[args.indexOf('--workspace') + 1];
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            surfaces: [{ ref: `surface:${workspaceRef}`, title: 'ws', type: 'terminal', selected: true }],
          }),
        });
      }
      return Promise.resolve({ code: 1, stderr: 'unexpected call', stdout: '' });
    };
    const res = await createBridge(run).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(2);
    expect(res.tabs.map((t) => t.workspaceRef).sort()).toEqual(['workspace:win-a', 'workspace:win-b']);
  });

  it('falls back to the single-window path when list-windows fails', async () => {
    const run: RunCmux = (args) => {
      if (args[0] === 'list-windows') return Promise.resolve({ code: 1, stderr: 'no such command', stdout: '' });
      if (args[0] === 'workspace' && args[1] === 'list') {
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            window_ref: 'window:1',
            workspaces: [{ ref: 'workspace:1', title: 'ws', current_directory: '/repo' }],
          }),
        });
      }
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ surfaces: [{ ref: 'surface:1', title: 'ws', type: 'terminal', selected: true }] }),
      });
    };
    const res = await createBridge(run).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0].workspaceRef).toBe('workspace:1');
  });
});

class FakeEventsChild extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn();
}

describe('bridge.watchEvents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('respawns the events child on close with bounded backoff, and unsubscribe stops respawns', () => {
    vi.useFakeTimers();
    const children: FakeEventsChild[] = [];
    const spawnEventsChild: SpawnEventsChild = vi.fn(() => {
      const child = new FakeEventsChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const noopRun: RunCmux = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
    const onChange = vi.fn();

    const unsubscribe = createBridge(noopRun, spawnEventsChild).watchEvents(onChange);
    expect(spawnEventsChild).toHaveBeenCalledTimes(1);

    children[0].emit('close', 1);
    expect(spawnEventsChild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(spawnEventsChild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawnEventsChild).toHaveBeenCalledTimes(2);

    children[1].emit('close', 1);
    vi.advanceTimersByTime(1999);
    expect(spawnEventsChild).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(spawnEventsChild).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(children[2].kill).toHaveBeenCalledTimes(1);

    children[2].emit('close', 1);
    vi.advanceTimersByTime(20000);
    expect(spawnEventsChild).toHaveBeenCalledTimes(3);
  });

  it('resets the backoff after a line is received, and forwards workspace/sidebar events', () => {
    vi.useFakeTimers();
    const children: FakeEventsChild[] = [];
    const spawnEventsChild: SpawnEventsChild = vi.fn(() => {
      const child = new FakeEventsChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const noopRun: RunCmux = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
    const onChange = vi.fn();

    createBridge(noopRun, spawnEventsChild).watchEvents(onChange);
    children[0].emit('close', 1);
    vi.advanceTimersByTime(1000);
    expect(spawnEventsChild).toHaveBeenCalledTimes(2);

    children[1].stdout.emit('data', `${JSON.stringify({ type: 'event', category: 'workspace' })}\n`);
    expect(onChange).toHaveBeenCalledTimes(1);

    children[1].emit('close', 1);
    vi.advanceTimersByTime(999);
    expect(spawnEventsChild).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(spawnEventsChild).toHaveBeenCalledTimes(3);
  });

  it('does not tight-loop respawn when cmux is absent (ENOENT-style error)', () => {
    vi.useFakeTimers();
    const children: FakeEventsChild[] = [];
    const spawnEventsChild: SpawnEventsChild = vi.fn(() => {
      const child = new FakeEventsChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const noopRun: RunCmux = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });

    createBridge(noopRun, spawnEventsChild).watchEvents(() => {});
    children[0].emit('error', Object.assign(new Error('spawn cmux ENOENT'), { code: 'ENOENT' }));
    vi.advanceTimersByTime(500);
    expect(spawnEventsChild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(spawnEventsChild).toHaveBeenCalledTimes(2);
  });
});

describe('bridge default run (no injected run)', () => {
  afterEach(async () => {
    vi.mocked((await import('node:child_process')).spawn).mockReset();
  });

  it('spawns cmux with argv-only args, no shell, and CMUX_QUIET=1', async () => {
    const cp = await import('node:child_process');
    const spawnMock = vi.mocked(cp.spawn);
    const fakeChild = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    spawnMock.mockImplementation((..._args: unknown[]) => {
      queueMicrotask(() => fakeChild.emit('close', 0));
      return fakeChild as unknown as ReturnType<typeof cp.spawn>;
    });

    await createBridge().send('surface:1', 'echo hi', false);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('cmux');
    expect(Array.isArray(args)).toBe(true);
    expect(opts).toBeDefined();
    expect((opts as { shell?: boolean }).shell).not.toBe(true);
    expect((opts as { env?: Record<string, string> }).env?.CMUX_QUIET).toBe('1');
  });
});
