import { describe, expect, it, vi } from 'vitest';
import { createWezTermBridge, type RunWez } from './bridge';

vi.mock('node:child_process', () => {
  const spawn = vi.fn();
  return { spawn, default: { spawn } };
});

const ok = (stdout = ''): Promise<{ code: number; stdout: string; stderr: string }> =>
  Promise.resolve({ code: 0, stdout, stderr: '' });

const PANES = JSON.stringify([
  {
    window_id: 0,
    tab_id: 0,
    pane_id: 0,
    workspace: 'default',
    title: 'cmd.exe',
    cwd: 'file:///C:/repo/',
    is_active: true,
  },
]);

function recorder(stdout = ''): { calls: string[][]; run: RunWez } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return ok(stdout);
    },
  };
}

describe('wezterm bridge.send', () => {
  it('passes user text as a single argv element (no shell)', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge(run).send('0', 'rm -rf $(pwd); echo pwned', false);
    expect(calls).toEqual([['cli', 'send-text', '--pane-id', '0', '--no-paste', 'rm -rf $(pwd); echo pwned']]);
  });

  it('sends Enter as a carriage return, since wezterm has no send-key', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge(run).send('0', 'ls', true);
    expect(calls).toEqual([
      ['cli', 'send-text', '--pane-id', '0', '--no-paste', 'ls'],
      ['cli', 'send-text', '--pane-id', '0', '--no-paste', '\r'],
    ]);
  });

  it('refuses a surfaceRef that is not a pane id', async () => {
    const { calls, run } = recorder();
    const res = await createWezTermBridge(run).send('surface:1; rm -rf /', 'ls', false);
    expect(res).toEqual({ ok: false, error: 'not a wezterm pane id: surface:1; rm -rf /' });
    expect(calls).toEqual([]);
  });
});

describe('wezterm bridge.sendKey', () => {
  it('translates a key to bytes and writes them as text', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge(run).sendKey('3', 'ctrl+c');
    expect(calls).toEqual([['cli', 'send-text', '--pane-id', '3', '--no-paste', '\x03']]);
  });

  it('rejects an unknown key instead of typing it into the pane', async () => {
    const { calls, run } = recorder();
    const res = await createWezTermBridge(run).sendKey('3', 'sudo reboot');
    expect(res).toEqual({ ok: false, error: 'unsupported key: sudo reboot' });
    expect(calls).toEqual([]);
  });
});

describe('wezterm bridge.listTabs', () => {
  it('reports not connected when wezterm errors', async () => {
    const bridge = createWezTermBridge(() => Promise.reject(new Error('ENOENT: wezterm')));
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('reports not connected on a non-zero exit (no GUI running)', async () => {
    const bridge = createWezTermBridge(() =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'failed to connect to Socket("gui-sock-1")' }),
    );
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('parses the pane list into tabs', async () => {
    const res = await createWezTermBridge(() => ok(PANES)).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0].surfaceRef).toBe('0');
    expect(res.tabs[0].cwd).toMatch(/repo/);
  });

  const TWO_PANES = JSON.stringify([
    { window_id: 0, tab_id: 0, pane_id: 0, title: 'a', is_active: true },
    { window_id: 0, tab_id: 1, pane_id: 1, title: 'b', is_active: true },
  ]);

  it('selects only the focused pane, not the active pane of every tab', async () => {
    const run: RunWez = (args) =>
      args[1] === 'list-clients' ? ok(JSON.stringify([{ focused_pane_id: 1 }])) : ok(TWO_PANES);
    const res = await createWezTermBridge(run).listTabs();
    expect(res.tabs.map((t) => t.selected)).toEqual([false, true]);
  });

  it('still lists tabs when list-clients fails', async () => {
    const run: RunWez = (args) =>
      args[1] === 'list-clients'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'nope' })
        : ok(TWO_PANES);
    const res = await createWezTermBridge(run).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(2);
  });
});

describe('wezterm bridge.readScreen', () => {
  it('asks for the requested number of scrollback lines', async () => {
    const { calls, run } = recorder('hello\n\n\n');
    const res = await createWezTermBridge(run).readScreen('2', 40);
    expect(calls).toEqual([['cli', 'get-text', '--pane-id', '2', '--start-line', '-40']]);
    expect(res).toEqual({ ok: true, text: 'hello' });
  });
});

describe('wezterm bridge.watchEvents', () => {
  it('fires only when the pane set changes, not on every poll', async () => {
    vi.useFakeTimers();
    try {
      let stdout = PANES;
      const onChange = vi.fn();
      const stop = createWezTermBridge(() => ok(stdout), 10).watchEvents(onChange);

      await vi.advanceTimersByTimeAsync(35);
      expect(onChange).not.toHaveBeenCalled();

      stdout = JSON.stringify([
        ...(JSON.parse(PANES) as unknown[]),
        { window_id: 0, tab_id: 0, pane_id: 1, title: 'sh', is_active: false },
      ]);
      await vi.advanceTimersByTimeAsync(15);
      expect(onChange).toHaveBeenCalledTimes(1);

      stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
