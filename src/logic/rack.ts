export type PanelId = 'newrun' | 'backlog' | 'running' | 'recent' | 'myprs' | 'shipped' | 'activity';

export const ALL_PANELS: PanelId[] = [
  'newrun',
  'backlog',
  'running',
  'recent',
  'myprs',
  'shipped',
  'activity',
];

export interface RackSlot {
  panels: PanelId[];
  active: PanelId;
  collapsed: boolean;
}

export type RackLayout = RackSlot[][];

const PANEL_SET: Set<string> = new Set(ALL_PANELS);

function unit(panel: PanelId): RackSlot {
  return { panels: [panel], active: panel, collapsed: false };
}

export function defaultLayout(): RackLayout {
  return [
    [unit('newrun'), unit('backlog'), unit('running'), unit('myprs')],
    [unit('recent'), unit('activity'), unit('shipped')],
  ];
}

function clone(layout: RackLayout): RackLayout {
  return layout.map((col) => col.map((slot) => ({ ...slot, panels: [...slot.panels] })));
}

function locate(layout: RackLayout, panel: PanelId): { c: number; s: number } | null {
  for (let c = 0; c < layout.length; c++) {
    for (let s = 0; s < layout[c]!.length; s++) {
      if (layout[c]![s]!.panels.includes(panel)) return { c, s };
    }
  }
  return null;
}

function detach(layout: RackLayout, panel: PanelId): void {
  const at = locate(layout, panel);
  if (!at) return;
  const slot = layout[at.c]![at.s]!;
  slot.panels = slot.panels.filter((p) => p !== panel);
  if (slot.panels.length === 0) {
    layout[at.c]!.splice(at.s, 1);
  } else if (slot.active === panel) {
    slot.active = slot.panels[0]!;
  }
}

export function movePanel(
  layout: RackLayout,
  panel: PanelId,
  toColumn: number,
  toIndex: number,
): RackLayout {
  const next = clone(layout);
  detach(next, panel);
  const col = Math.max(0, Math.min(toColumn, next.length - 1));
  const index = Math.max(0, Math.min(toIndex, next[col]!.length));
  next[col]!.splice(index, 0, unit(panel));
  return next;
}

export function stackOnto(layout: RackLayout, panel: PanelId, onto: PanelId): RackLayout {
  if (panel === onto) return layout;
  const next = clone(layout);
  detach(next, panel);
  const at = locate(next, onto);
  if (!at) {
    next[0]!.push(unit(panel));
    return next;
  }
  const slot = next[at.c]![at.s]!;
  slot.panels.push(panel);
  slot.active = panel;
  slot.collapsed = false;
  return next;
}

export function setActive(layout: RackLayout, panel: PanelId): RackLayout {
  const next = clone(layout);
  const at = locate(next, panel);
  if (at) next[at.c]![at.s]!.active = panel;
  return next;
}

export function toggleCollapse(layout: RackLayout, panel: PanelId): RackLayout {
  const next = clone(layout);
  const at = locate(next, panel);
  if (at) {
    const slot = next[at.c]![at.s]!;
    slot.collapsed = !slot.collapsed;
  }
  return next;
}

export function serialize(layout: RackLayout): string {
  return JSON.stringify(layout);
}

interface RawSlot {
  panels?: unknown;
  active?: unknown;
  collapsed?: unknown;
}

export function deserialize(raw: string | null): RackLayout {
  if (!raw) return defaultLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultLayout();
  }
  if (!Array.isArray(parsed)) return defaultLayout();

  const seen: Set<string> = new Set();
  const columns: RackLayout = [];
  for (const rawCol of parsed) {
    if (!Array.isArray(rawCol)) continue;
    const col: RackSlot[] = [];
    for (const rawSlot of rawCol as RawSlot[]) {
      const rawPanels: unknown = rawSlot?.panels;
      if (!Array.isArray(rawPanels)) continue;
      const panels: PanelId[] = [];
      for (const p of rawPanels) {
        if (typeof p === 'string' && PANEL_SET.has(p) && !seen.has(p)) {
          seen.add(p);
          panels.push(p as PanelId);
        }
      }
      if (panels.length === 0) continue;
      const active: PanelId = panels.includes(rawSlot?.active as PanelId)
        ? (rawSlot!.active as PanelId)
        : panels[0]!;
      col.push({ panels, active, collapsed: rawSlot?.collapsed === true });
    }
    if (col.length > 0) columns.push(col);
  }

  const missing: PanelId[] = ALL_PANELS.filter((p) => !seen.has(p));
  if (columns.length === 0) {
    if (missing.length === 0) return defaultLayout();
    columns.push([]);
  }
  for (const p of missing) columns[columns.length - 1]!.push(unit(p));

  return columns;
}
