import { describe, expect, it, vi } from 'vitest';
import { createBridge, type RunCmux } from './bridge';

function fakeRun(script: (args: string[]) => { code?: number; stdout?: string; stderr?: string }): RunCmux {
  return (args) => Promise.resolve({ code: 0, stdout: '', stderr: '', ...script(args) });
}

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
});
