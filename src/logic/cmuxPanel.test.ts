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
  });
});
