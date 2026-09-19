import { describe, expect, it } from 'vitest';
import { cwdFromUrl, focusedPaneId, toTabs, type WezPane } from './model';

const pane = (over: Partial<WezPane> = {}): WezPane => ({
  window_id: 0,
  tab_id: 0,
  pane_id: 0,
  workspace: 'default',
  title: 'cmd.exe',
  cwd: 'file:///C:/Users/natha/',
  is_active: true,
  ...over,
});

describe('cwdFromUrl', () => {
  it('decodes a Windows file URL to a path', () => {
    const cwd = cwdFromUrl('file:///C:/Users/natha/');
    expect(cwd).toMatch(/^C:[\\/]Users[\\/]natha/);
    // fileURLToPath keeps the leading slash on macOS and Linux, so drive
    // letters are normalized before it is consulted. Must hold everywhere.
    expect(cwd!.startsWith('/')).toBe(false);
  });

  it('decodes percent-escapes', () => {
    expect(cwdFromUrl('file:///C:/Program%20Files/')).toMatch(/Program Files/);
  });

  it('resolves a remote authority without throwing', () => {
    // Windows maps this to a UNC path; POSIX rejects the authority and we fall
    // back to the pathname. Either way it must be a usable string, not a throw.
    const cwd = cwdFromUrl('file://somehost/srv/repo');
    expect(cwd).toContain('srv');
    expect(cwd).toContain('repo');
  });

  it('passes a plain path through and maps empty to null', () => {
    expect(cwdFromUrl('/srv/repo')).toBe('/srv/repo');
    expect(cwdFromUrl(null)).toBeNull();
    expect(cwdFromUrl(undefined)).toBeNull();
  });
});

describe('toTabs', () => {
  it('projects a pane row onto a CmuxTab', () => {
    const [tab] = toTabs([pane({ window_id: 2, tab_id: 3, pane_id: 7, title: 'nvim' })]);
    expect(tab.windowRef).toBe('window:2');
    expect(tab.workspaceRef).toBe('tab:3');
    expect(tab.surfaceRef).toBe('7');
    expect(tab.surfaceTitle).toBe('nvim');
    expect(tab.type).toBe('terminal');
    expect(tab.selected).toBe(true);
  });

  it('falls back to is_active when no focused pane is known', () => {
    const tabs = toTabs([pane({ pane_id: 0, is_active: true }), pane({ pane_id: 1, is_active: false })]);
    expect(tabs.map((t) => t.selected)).toEqual([true, false]);
  });

  it('treats a missing is_active as not selected', () => {
    expect(toTabs([pane({ is_active: undefined })])[0].selected).toBe(false);
  });

  it('selects only the focused pane, overriding per-tab is_active', () => {
    // wezterm marks the active pane of every tab, so is_active alone
    // would light up both of these.
    const tabs = toTabs([pane({ pane_id: 0, is_active: true }), pane({ pane_id: 1, is_active: true })], 1);
    expect(tabs.map((t) => t.selected)).toEqual([false, true]);
  });

  it('titles a tab by tab_title, then workspace, then id', () => {
    expect(toTabs([pane({ tab_title: 'build' })])[0].workspaceTitle).toBe('build');
    expect(toTabs([pane({ tab_title: '' })])[0].workspaceTitle).toBe('default');
    expect(toTabs([pane({ tab_title: '', workspace: '', tab_id: 4 })])[0].workspaceTitle).toBe('tab 4');
  });
});

describe('focusedPaneId', () => {
  it('returns the first client reporting a focused pane', () => {
    expect(focusedPaneId([{ focused_pane_id: null }, { focused_pane_id: 4 }])).toBe(4);
  });

  it('accepts pane 0, which is falsy but valid', () => {
    expect(focusedPaneId([{ focused_pane_id: 0 }])).toBe(0);
  });

  it('returns null when no client reports one', () => {
    expect(focusedPaneId([{}])).toBeNull();
    expect(focusedPaneId([])).toBeNull();
  });
});
