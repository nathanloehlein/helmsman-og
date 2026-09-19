import { describe, expect, it, vi } from 'vitest';
import { createWezTermBridge, type RunWez } from './bridge';

vi.mock('node:child_process', () => {
  const spawn = vi.fn();
  return { spawn, default: { spawn } };
});

const SOCK = (): string => '/run/gui-sock-1';

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
    await createWezTermBridge({ run, socket: SOCK }).send('0', 'rm -rf $(pwd); echo pwned', false);
    expect(calls).toEqual([['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', 'rm -rf $(pwd); echo pwned']]);
  });

  it('sends Enter as a carriage return, since wezterm has no send-key', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge({ run, socket: SOCK }).send('0', 'ls', true);
    expect(calls).toEqual([
      ['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', 'ls'],
      ['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', '\r'],
    ]);
  });

  it('refuses a surfaceRef that is not a pane id', async () => {
    const { calls, run } = recorder();
    const res = await createWezTermBridge({ run, socket: SOCK }).send('surface:1; rm -rf /', 'ls', false);
    expect(res).toEqual({ ok: false, error: 'not a wezterm pane id: surface:1; rm -rf /' });
    expect(calls).toEqual([]);
  });
});

describe('wezterm bridge.sendKey', () => {
  it('translates a key to bytes and writes them as text', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge({ run, socket: SOCK }).sendKey('3', 'ctrl+c');
    expect(calls).toEqual([['cli', 'send-text', '--pane-id', '3', '--no-paste', '--', '\x03']]);
  });

  it('rejects an unknown key instead of typing it into the pane', async () => {
    const { calls, run } = recorder();
    const res = await createWezTermBridge({ run, socket: SOCK }).sendKey('3', 'sudo reboot');
    expect(res).toEqual({ ok: false, error: 'unsupported key: sudo reboot' });
    expect(calls).toEqual([]);
  });
});

describe('wezterm bridge.listTabs', () => {
  it('reports not connected when wezterm errors', async () => {
    const bridge = createWezTermBridge({ run: () => Promise.reject(new Error('ENOENT: wezterm')), socket: SOCK });
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('reports not connected on a non-zero exit (no GUI running)', async () => {
    const bridge = createWezTermBridge({
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'failed to connect to Socket("gui-sock-1")' }),
      socket: SOCK,
    });
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('parses the pane list into tabs', async () => {
    const res = await createWezTermBridge({ run: () => ok(PANES), socket: SOCK }).listTabs();
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
    const res = await createWezTermBridge({ run, socket: SOCK }).listTabs();
    expect(res.tabs.map((t) => t.selected)).toEqual([false, true]);
  });

  it('still lists tabs when list-clients fails', async () => {
    const run: RunWez = (args) =>
      args[1] === 'list-clients'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'nope' })
        : ok(TWO_PANES);
    const res = await createWezTermBridge({ run, socket: SOCK }).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(2);
  });
});

describe('wezterm bridge.readScreen', () => {
  it('asks for the requested number of scrollback lines', async () => {
    const { calls, run } = recorder('hello\n\n\n');
    const res = await createWezTermBridge({ run, socket: SOCK }).readScreen('2', 40);
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
      const stop = createWezTermBridge({ run: () => ok(stdout), pollMs: 10, socket: SOCK }).watchEvents(onChange);

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

describe('wezterm bridge with nothing to connect to', () => {
  const NO_SOCK = (): null => null;

  // Without this guard `wezterm cli` reaches its default unix domain and
  // silently starts a headless wezterm-mux-server, so the panel would report
  // connected and accept input for panes that have no window.
  it('reports disconnected without spawning wezterm', async () => {
    const { calls, run } = recorder(PANES);
    const res = await createWezTermBridge({ run, socket: NO_SOCK }).listTabs();
    expect(res).toEqual({ connected: false, tabs: [] });
    expect(calls).toEqual([]);
  });

  it('refuses reads and writes without spawning wezterm', async () => {
    const { calls, run } = recorder();
    const bridge = createWezTermBridge({ run, socket: NO_SOCK });
    expect(await bridge.readScreen('0', 40)).toEqual({ ok: false, error: 'wezterm is not running' });
    expect(await bridge.send('0', 'ls', true)).toEqual({ ok: false, error: 'wezterm is not running' });
    expect(await bridge.sendKey('0', 'enter')).toEqual({ ok: false, error: 'wezterm is not running' });
    expect(calls).toEqual([]);
  });

  // WEZTERM_SOCKET is the opt-in for a headless mux domain: resolveSocket
  // returns it whether or not a GUI is up, so the guard must not block it.
  it('drives a deliberately configured socket even with no GUI', async () => {
    const { calls, run } = recorder(PANES);
    const res = await createWezTermBridge({ run, socket: () => '/pinned/mux' }).listTabs();
    expect(res.connected).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('wezterm bridge.watchEvents concurrency', () => {
  it('does not start a new poll while one is still running', async () => {
    vi.useFakeTimers();
    try {
      let started = 0;
      // A holder, because TS narrows a plain `let` assigned inside an executor
      // to never at the call site.
      const pending: { release: (() => void) | null } = { release: null };
      const run: RunWez = () => {
        started += 1;
        return new Promise((resolve) => {
          pending.release = (): void => resolve({ code: 0, stdout: PANES, stderr: '' });
        });
      };
      const stop = createWezTermBridge({ run, pollMs: 10, socket: SOCK }).watchEvents(() => {});

      // The first list is still pending across several intervals.
      await vi.advanceTimersByTimeAsync(50);
      expect(started).toBe(1);

      pending.release?.();
      await vi.advanceTimersByTimeAsync(20);
      expect(started).toBeGreaterThan(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Without a `--` terminator wezterm parses leading-hyphen text as its own flag.
// `--help` is the dangerous one: it prints help and exits 0, so the send looks
// successful while nothing was typed, and enter=true then lands Enter on
// whatever the pane already held.
describe('wezterm bridge with leading-hyphen payloads', () => {
  it('terminates options before user text in send', async () => {
    const { calls, run } = recorder();
    const res = await createWezTermBridge({ run, socket: SOCK }).send('0', '--help', true);
    expect(res).toEqual({ ok: true });
    expect(calls[0]).toEqual(['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', '--help']);
    expect(calls[1]).toEqual(['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', '\r']);
  });

  it('terminates options for every hyphen-shaped payload', async () => {
    for (const text of ['--help', '-h', '--no-paste', '--pane-id']) {
      const { calls, run } = recorder();
      await createWezTermBridge({ run, socket: SOCK }).send('0', text, false);
      expect(calls[0]!.slice(-2)).toEqual(['--', text]);
    }
  });

  it('terminates options in sendKey too', async () => {
    const { calls, run } = recorder();
    await createWezTermBridge({ run, socket: SOCK }).sendKey('0', 'escape');
    expect(calls[0]).toEqual(['cli', 'send-text', '--pane-id', '0', '--no-paste', '--', '\x1b']);
  });
});

// providerOf drives the panel's action buttons and is derived from the title,
// so a pane becoming an agent has to raise an event even though no id changed.
describe('wezterm bridge.watchEvents provider transitions', () => {
  const pane = (title: string): string =>
    JSON.stringify([{ window_id: 0, tab_id: 0, pane_id: 0, title, is_active: true }]);

  async function transitions(from: string, to: string): Promise<number> {
    vi.useFakeTimers();
    try {
      let stdout = pane(from);
      const onChange = vi.fn();
      const stop = createWezTermBridge({ run: () => ok(stdout), pollMs: 10, socket: SOCK }).watchEvents(onChange);
      await vi.advanceTimersByTimeAsync(35);
      stdout = pane(to);
      await vi.advanceTimersByTimeAsync(35);
      stop();
      return onChange.mock.calls.length;
    } finally {
      vi.useRealTimers();
    }
  }

  it('fires when a shell starts an agent', async () => {
    expect(await transitions('zsh', 'codex')).toBe(1);
  });

  it('fires when an agent exits back to a shell', async () => {
    expect(await transitions('claude.exe', 'cmd.exe')).toBe(1);
  });

  it('stays quiet for a title change that does not change the provider', async () => {
    expect(await transitions('zsh', 'zsh: vim README.md')).toBe(0);
  });
});
