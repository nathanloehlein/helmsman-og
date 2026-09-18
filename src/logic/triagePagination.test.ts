import { describe, expect, it } from 'vitest';
import type { Ticket } from '../types';
import { paginateTriageTickets, TRIAGE_PAGE_SIZES, type TriagePageSize } from './triagePagination';
import { loadTriagePageSize, saveTriagePageSize } from './prefs';

const tickets: Ticket[] = Array.from({ length: 27 }, (_, i) => ({ id: `TASK-${i}`, title: 'Ticket', priority: 'P2', status: 'backlog', repo: 'org/a' }));

describe('triage pagination', () => {
  it.each(TRIAGE_PAGE_SIZES)('caps pages at %i tickets without mutating the input', size => {
    const result = paginateTriageTickets(tickets, size, 1);
    expect(result.tickets).toHaveLength(Math.min(size, 27));
    expect(result).toMatchObject({ total: 27, start: 1, end: Math.min(size, 27), pages: Math.ceil(27 / size), page: 1 });
    expect(tickets).toHaveLength(27);
  });

  it('clamps the page after result counts shrink and reports the final partial range', () => {
    const result = paginateTriageTickets(tickets, 10, 12);
    expect(result).toMatchObject({ total: 27, start: 21, end: 27, page: 3, pages: 3 });
    expect(result.tickets).toEqual(tickets.slice(20));
    expect(paginateTriageTickets([], 10, 12)).toEqual({ tickets: [], total: 0, start: 0, end: 0, page: 1, pages: 1 });
  });

  it('sorts the whole matching list before slicing while retaining order within each priority', () => {
    const input = [...tickets.slice(0, 10), { ...tickets[0]!, id: 'P0', priority: 'P0' as const }];
    const first = paginateTriageTickets(input, 5, 1);
    expect(first.tickets.map(ticket => ticket.id)).toEqual(['P0', 'TASK-0', 'TASK-1', 'TASK-2', 'TASK-3']);
    expect(paginateTriageTickets(input, 5, 2).tickets.map(ticket => ticket.id)).toEqual(['TASK-4', 'TASK-5', 'TASK-6', 'TASK-7', 'TASK-8']);
    expect(input.at(-1)?.id).toBe('P0');
  });

  it.each([NaN, Infinity, -1, 0, 1.5])('normalizes invalid page %j', page => {
    expect(paginateTriageTickets(tickets, 10, page).page).toBe(1);
  });

  it('uses the default page size for unsupported values', () => {
    expect(paginateTriageTickets(tickets, 0 as TriagePageSize, 1).tickets).toHaveLength(10);
  });

  it('persists valid page sizes and safely defaults missing or malformed preferences', () => {
    localStorage.removeItem('helmsman.triagePageSize');
    expect(loadTriagePageSize()).toBe(10);
    for (const size of TRIAGE_PAGE_SIZES) {
      saveTriagePageSize(size);
      expect(loadTriagePageSize()).toBe(size);
    }
    localStorage.setItem('helmsman.triagePageSize', '0');
    expect(loadTriagePageSize()).toBe(10);
    localStorage.removeItem('helmsman.triagePageSize');
  });
});
