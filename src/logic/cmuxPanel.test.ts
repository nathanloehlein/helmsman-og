import { describe, expect, it } from 'vitest';
import { selectSurface, isPolling, providerOf, type CmuxTabView } from './cmuxPanel';

const tab = (over: Partial<CmuxTabView>): CmuxTabView => ({
  windowRef: 'window:1',
  workspaceRef: 'workspace:1',
  workspaceTitle: 'ws',
  surfaceRef: 'surface:1',
  surfaceTitle: 's',
  type: 'terminal',
  cwd: null,
  selected: false,
  ...over,
});

describe('cmuxPanel', () => {
  it('selecting a surface stores it and enables polling', () => {
    const s = selectSurface({ selectedSurface: null }, 'surface:2');
    expect(s.selectedSurface).toBe('surface:2');
    expect(isPolling(s)).toBe(true);
  });

  it('no selection means no polling', () => {
    expect(isPolling({ selectedSurface: null })).toBe(false);
  });

  it('providerOf is null for a plain terminal', () => {
    expect(providerOf(tab({ type: 'terminal' }))).toBeNull();
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'cmd.exe' }))).toBeNull();
  });

  // wezterm has no surface types, so the running command's title is the only
  // signal that a pane holds an agent.
  it('providerOf detects an agent from a wezterm pane title', () => {
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'claude' }))).toBe('claude');
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'codex exec' }))).toBe('codex');
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'opencode' }))).toBe('opencode');
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'node -- claude --resume' }))).toBe('claude');
  });

  it('providerOf does not match a name embedded in a longer word', () => {
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'claude-config' }))).toBeNull();
    expect(providerOf(tab({ type: 'terminal', surfaceTitle: 'myclaude' }))).toBeNull();
  });

  it('providerOf keeps cmux agent-sessions working, refined by title', () => {
    expect(providerOf(tab({ type: 'agent-session' }))).toBe('claude');
    expect(providerOf(tab({ type: 'agent-session', surfaceTitle: 'codex' }))).toBe('codex');
  });
});
