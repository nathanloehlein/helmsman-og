import { describe, expect, it } from 'vitest';
import {
  ALL_PANELS,
  defaultLayout,
  deserialize,
  movePanel,
  serialize,
  setActive,
  stackOnto,
  toggleCollapse,
  type PanelId,
  type RackLayout,
} from './rack';

function allPanelsIn(layout: RackLayout): PanelId[] {
  return layout.flat().flatMap((s) => s.panels);
}

describe('rack layout', () => {
  it('default layout contains every panel exactly once across two columns', () => {
    const l = defaultLayout();
    expect(l).toHaveLength(2);
    const panels = allPanelsIn(l).sort();
    expect(panels).toEqual([...ALL_PANELS].sort());
  });

  it('movePanel reorders within a column and keeps completeness', () => {
    const l = movePanel(defaultLayout(), 'running', 0, 0);
    expect(l[0]![0]!.panels).toEqual(['running']);
    expect(allPanelsIn(l).sort()).toEqual([...ALL_PANELS].sort());
  });

  it('movePanel across columns removes the emptied source slot', () => {
    const start = defaultLayout();
    const col0Len = start[0]!.length;
    const l = movePanel(start, 'newrun', 1, 0);
    expect(l[1]![0]!.panels).toEqual(['newrun']);
    expect(l[0]!).toHaveLength(col0Len - 1);
    expect(allPanelsIn(l).sort()).toEqual([...ALL_PANELS].sort());
  });

  it('stackOnto tab-stacks a panel and makes it active', () => {
    const l = stackOnto(defaultLayout(), 'running', 'backlog');
    const slot = l.flat().find((s) => s.panels.includes('backlog'))!;
    expect(slot.panels).toContain('running');
    expect(slot.active).toBe('running');
    expect(allPanelsIn(l).sort()).toEqual([...ALL_PANELS].sort());
  });

  it('stackOnto is a no-op onto itself', () => {
    const l = defaultLayout();
    expect(stackOnto(l, 'backlog', 'backlog')).toBe(l);
  });

  it('setActive switches the active tab within a stack', () => {
    const stacked = stackOnto(defaultLayout(), 'running', 'backlog');
    const l = setActive(stacked, 'backlog');
    const slot = l.flat().find((s) => s.panels.includes('backlog'))!;
    expect(slot.active).toBe('backlog');
  });

  it('toggleCollapse flips the containing slot', () => {
    const l = toggleCollapse(defaultLayout(), 'shipped');
    const slot = l.flat().find((s) => s.panels.includes('shipped'))!;
    expect(slot.collapsed).toBe(true);
  });

  it('does not mutate the input layout', () => {
    const l = defaultLayout();
    const snapshot = serialize(l);
    movePanel(l, 'shipped', 0, 0);
    stackOnto(l, 'activity', 'backlog');
    expect(serialize(l)).toBe(snapshot);
  });

  it('serialize/deserialize round-trips', () => {
    const l = toggleCollapse(stackOnto(defaultLayout(), 'running', 'backlog'), 'shipped');
    expect(deserialize(serialize(l))).toEqual(l);
  });

  it('deserialize drops unknown ids, dedupes, and appends missing panels', () => {
    const raw = JSON.stringify([[{ panels: ['backlog', 'bogus', 'backlog'], active: 'backlog', collapsed: false }]]);
    const l = deserialize(raw);
    expect(allPanelsIn(l).sort()).toEqual([...ALL_PANELS].sort());
    expect(l[0]![0]!.panels).toEqual(['backlog']);
  });

  it('deserialize falls back to default on garbage or null', () => {
    expect(deserialize('not json')).toEqual(defaultLayout());
    expect(deserialize(null)).toEqual(defaultLayout());
    expect(deserialize('{}')).toEqual(defaultLayout());
  });

  it('deserialize repairs an out-of-set active to the first panel', () => {
    const raw = JSON.stringify([[{ panels: ['backlog'], active: 'running', collapsed: false }]]);
    const l = deserialize(raw);
    const slot = l.flat().find((s) => s.panels.includes('backlog'))!;
    expect(slot.active).toBe('backlog');
  });
});
