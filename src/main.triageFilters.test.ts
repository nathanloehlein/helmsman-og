import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { TriageGroupsView } from './data/triage';
import type { Priority, Ticket } from './types';
import type { TriageColumn } from './logic/triagePagination';

let view: DashboardView | null = null;
const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
const json = (value: unknown) => new Response(JSON.stringify(value));

function tickets(prefix: string): Ticket[] {
  const ageDays = [0.5, 3, 15, 31, null];
  return priorities.map((priority, index) => ({
    id: `${prefix}-${index}`,
    title: `${priority} ticket in ${prefix}`,
    priority,
    status: 'backlog',
    repo: 'org/a',
    updatedAt: ageDays[index] == null ? undefined : new Date(Date.now() - ageDays[index]! * 86_400_000).toISOString(),
  }));
}

function manyTickets(prefix: string): Ticket[] {
  return Array.from({ length: 63 }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `Ticket ${index} in ${prefix}`,
    priority: priorities[index % priorities.length]!,
    status: 'backlog' as const,
    repo: 'org/a',
    updatedAt: new Date(Date.now() - 43_200_000).toISOString(),
  })).reverse();
}

async function setup(makeTickets = tickets) {
  window.history.replaceState(null, '', '/triage?repo=org/a');
  const snapshot = await loadDashboard();
  const groups: TriageGroupsView = {
    unassignedBacklog: makeTickets('BACKLOG'),
    unassignedTodo: makeTickets('TODO'),
    mineOpen: makeTickets('MINE'),
  };
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a'], selectedRepo: 'org/a', jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/triage') return json({ groups, degraded: false, selectedRepo: 'org/a', jiraBaseUrl: null });
    return new Response(null, { status: 404 });
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  view = new DashboardView(root);
  await view.start();
  await vi.advanceTimersByTimeAsync(0);
  const setPriority = async (priority: Priority, checked: boolean) => {
    const input = root.querySelector<HTMLInputElement>(`[data-triage-priority="${priority}"]`)!;
    input.focus();
    input.checked = checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  };
  const setDays = async (days: number) => {
    const select = root.querySelector<HTMLSelectElement>('[data-triage-days]')!;
    select.focus();
    select.value = String(days);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  };
  const visiblePriorities = () => [...root.querySelectorAll('.triage-group')].map(group => [...group.querySelectorAll('.triage-row .pri-chip')].map(chip => chip.textContent));
  const counts = () => [...root.querySelectorAll('.triage-group .panel-count')].map(count => Number(count.textContent));
  const ranges = () => [...root.querySelectorAll('.triage-page-range')].map(range => range.textContent);
  const setSize = async (size: number) => {
    const select = root.querySelector<HTMLSelectElement>('[data-triage-page-size]')!;
    select.focus();
    select.value = String(size);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  };
  const goToPage = async (column: TriageColumn, page: number) => {
    const button = root.querySelector<HTMLButtonElement>(`button[data-triage-column="${column}"][data-triage-page="${page}"]:not(:disabled)`)!;
    expect(button).not.toBeNull();
    button.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { root, requests, groups, setPriority, setDays, visiblePriorities, counts, ranges, setSize, goToPage };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-17T21:00:00Z');
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('shared triage filters', () => {
  it('starts with all priorities and any time, including undated tickets, in every column', async () => {
    const { root, visiblePriorities, counts } = await setup();
    expect(root.querySelectorAll('.triage-filters')).toHaveLength(1);
    expect(root.querySelectorAll('[data-triage-priority]:checked')).toHaveLength(5);
    expect(root.querySelector<HTMLSelectElement>('[data-triage-days]')?.value).toBe('0');
    expect(visiblePriorities()).toEqual([priorities, priorities, priorities]);
    expect(counts()).toEqual([5, 5, 5]);
  });

  it('combines priorities across all three columns and allows an empty selection without fetching', async () => {
    const { root, requests, setPriority, visiblePriorities, counts } = await setup();
    const requestsBefore = [...requests];
    for (const priority of ['P1', 'P3', 'P4'] as Priority[]) await setPriority(priority, false);
    expect(visiblePriorities()).toEqual([['P0', 'P2'], ['P0', 'P2'], ['P0', 'P2']]);
    expect(counts()).toEqual([2, 2, 2]);
    expect(document.activeElement).toBe(root.querySelector('[data-triage-priority="P4"]'));
    await setPriority('P0', false);
    await setPriority('P2', false);
    expect(visiblePriorities()).toEqual([[], [], []]);
    expect(root.querySelectorAll('.triage-group .empty-note')).toHaveLength(3);
    expect(counts()).toEqual([0, 0, 0]);
    await setPriority('P4', true);
    expect(visiblePriorities()).toEqual([['P4'], ['P4'], ['P4']]);
    expect(requests).toEqual(requestsBefore);
  });

  it('applies each last-updated window to every column and combines it with priority without fetching', async () => {
    const { root, requests, setDays, setPriority, visiblePriorities } = await setup();
    const requestsBefore = [...requests];
    for (const [days, expected] of [[30, ['P0', 'P1', 'P2']], [7, ['P0', 'P1']], [1, ['P0']], [0, priorities]] as const) {
      await setDays(days);
      expect(visiblePriorities()).toEqual([expected, expected, expected]);
      expect(document.activeElement).toBe(root.querySelector('[data-triage-days]'));
    }
    await setPriority('P0', false);
    await setDays(7);
    expect(visiblePriorities()).toEqual([['P1'], ['P1'], ['P1']]);
    expect(requests).toEqual(requestsBefore);
  });

  it('preserves the shared selection through navigation and a new app instance', async () => {
    const { root, setDays, setPriority, visiblePriorities } = await setup();
    await setPriority('P0', false);
    await setDays(7);
    for (const page of ['runs', 'triage']) {
      root.querySelector<HTMLAnchorElement>(`[data-view="${page}"]`)!.click();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(visiblePriorities()).toEqual([['P1'], ['P1'], ['P1']]);
    view!.destroy();
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector<HTMLInputElement>('[data-triage-priority="P0"]')?.checked).toBe(false);
    expect(root.querySelectorAll('[data-triage-priority]:checked')).toHaveLength(4);
    expect(root.querySelector<HTMLSelectElement>('[data-triage-days]')?.value).toBe('7');
    expect(visiblePriorities()).toEqual([['P1'], ['P1'], ['P1']]);
  });
});

describe('triage pagination', () => {
  it('sorts before paging, keeps pages independent, and preserves filtered totals without fetching', async () => {
    const { root, requests, visiblePriorities, counts, ranges, goToPage } = await setup(manyTickets);
    const requestsBefore = [...requests];
    expect(root.querySelector<HTMLSelectElement>('[data-triage-page-size]')?.value).toBe('10');
    expect(visiblePriorities()).toEqual(Array.from({ length: 3 }, () => Array(10).fill('P0')));
    expect(counts()).toEqual([63, 63, 63]);
    expect(ranges()).toEqual(['1–10 of 63', '1–10 of 63', '1–10 of 63']);
    await goToPage('backlog', 2);
    expect(visiblePriorities()[0]).toEqual([...Array(3).fill('P0'), ...Array(7).fill('P1')]);
    expect(visiblePriorities()[1]).toEqual(Array(10).fill('P0'));
    await goToPage('mine', 2);
    await goToPage('mine', 3);
    expect(ranges()).toEqual(['11–20 of 63', '1–10 of 63', '21–30 of 63']);
    expect(counts()).toEqual([63, 63, 63]);
    expect(requests).toEqual(requestsBefore);
  });

  it('applies each shared page size to every column locally and restores the saved size', async () => {
    const { root, requests, setSize, visiblePriorities, counts, goToPage, ranges } = await setup(manyTickets);
    const requestsBefore = [...requests];
    for (const size of [5, 10, 25, 50, 100]) {
      await setSize(size);
      expect(visiblePriorities().map(rows => rows.length)).toEqual(Array(3).fill(Math.min(size, 63)));
      expect(counts()).toEqual([63, 63, 63]);
      expect(document.activeElement).toBe(root.querySelector('[data-triage-page-size]'));
    }
    await setSize(25);
    await goToPage('todo', 2);
    await goToPage('todo', 3);
    expect(ranges()).toEqual(['1–25 of 63', '51–63 of 63', '1–25 of 63']);
    expect(visiblePriorities()[1]).toHaveLength(13);
    expect(root.querySelector<HTMLButtonElement>('button[data-triage-column="todo"][aria-label^="Next"]')?.disabled).toBe(true);
    expect(requests).toEqual(requestsBefore);
    view!.destroy();
    view = new DashboardView(root);
    await view.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector<HTMLSelectElement>('[data-triage-page-size]')?.value).toBe('25');
    expect(visiblePriorities().map(rows => rows.length)).toEqual([25, 25, 25]);
    expect(ranges()).toEqual(Array(3).fill('1–25 of 63'));
  });

  it('resets every column to the first page after priority, date, size, and repository changes', async () => {
    const { root, setPriority, setDays, setSize, goToPage, ranges } = await setup(manyTickets);
    const advanceColumns = async () => {
      for (const column of ['backlog', 'todo', 'mine'] as const) await goToPage(column, 2);
    };
    await advanceColumns();
    await setPriority('P4', false);
    expect(ranges()).toEqual(Array(3).fill('1–10 of 51'));
    await advanceColumns();
    await setDays(7);
    expect(ranges()).toEqual(Array(3).fill('1–10 of 51'));
    await advanceColumns();
    await setSize(5);
    expect(ranges()).toEqual(Array(3).fill('1–5 of 51'));
    await advanceColumns();
    const repo = root.querySelector<HTMLSelectElement>('.repo-select')!;
    repo.value = 'org/b';
    repo.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ranges()).toEqual(Array(3).fill('1–5 of 51'));
  });

  it('clamps pages when reloaded data shrinks and retains that page when tickets return', async () => {
    const { root, groups, goToPage, ranges, visiblePriorities } = await setup(manyTickets);
    await goToPage('backlog', 2);
    await goToPage('backlog', 3);
    await goToPage('mine', 2);
    const originalBacklog = groups.unassignedBacklog;
    groups.unassignedBacklog = groups.unassignedBacklog.slice(0, 12);
    groups.mineOpen = [];
    root.querySelector<HTMLAnchorElement>('[data-view="triage"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ranges()).toEqual(['11–12 of 12', '1–10 of 63', '0 of 0']);
    expect(visiblePriorities().map(rows => rows.length)).toEqual([2, 10, 0]);
    groups.unassignedBacklog = originalBacklog;
    root.querySelector<HTMLAnchorElement>('[data-view="triage"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ranges()).toEqual(['11–20 of 63', '1–10 of 63', '0 of 0']);
  });
});
