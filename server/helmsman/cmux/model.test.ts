import { describe, expect, it } from 'vitest';
import { toTabs } from './model';

describe('toTabs', () => {
  it('joins workspaces to their surfaces into flat tabs', () => {
    const tabs = toTabs(
      [{ windowRef: 'window:1', workspaceRef: 'workspace:1', workspaceTitle: 'Open Helmsman', cwd: '/repo' }],
      { 'workspace:1': [{ surfaceRef: 'surface:1', surfaceTitle: 'Open Helmsman', type: 'terminal', selected: true }] },
    );
    expect(tabs).toEqual([
      {
        windowRef: 'window:1',
        workspaceRef: 'workspace:1',
        workspaceTitle: 'Open Helmsman',
        surfaceRef: 'surface:1',
        surfaceTitle: 'Open Helmsman',
        type: 'terminal',
        cwd: '/repo',
        selected: true,
      },
    ]);
  });

  it('emits one tab per surface when a workspace has several', () => {
    const tabs = toTabs(
      [{ windowRef: 'window:1', workspaceRef: 'workspace:2', workspaceTitle: 'ws', cwd: null }],
      {
        'workspace:2': [
          { surfaceRef: 'surface:1', surfaceTitle: 'a', type: 'terminal', selected: false },
          { surfaceRef: 'surface:2', surfaceTitle: 'b', type: 'browser', selected: true },
        ],
      },
    );
    expect(tabs.map((t) => t.surfaceRef)).toEqual(['surface:1', 'surface:2']);
    expect(tabs[1].type).toBe('browser');
  });

  it('emits no tabs for a workspace with no surfaces', () => {
    const tabs = toTabs([{ windowRef: 'window:1', workspaceRef: 'workspace:9', workspaceTitle: 'empty', cwd: null }], {});
    expect(tabs).toEqual([]);
  });
});
