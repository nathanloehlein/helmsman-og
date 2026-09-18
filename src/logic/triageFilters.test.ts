import { describe, expect, it } from 'vitest';
import type { Ticket } from '../types';
import { defaultTriageFilters, filterTriageTickets, parseTriageFilters } from './triageFilters';

const now = Date.parse('2026-09-17T12:00:00Z');
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 'TEST-1', title: 'Ticket', priority: 'P0', status: 'backlog', repo: 'org/a', ...overrides });

describe('triage filters', () => {
  it('defaults to all five priorities without excluding undated tickets', () => {
    const filters = defaultTriageFilters();
    expect(filters).toEqual({ priorities: ['P0', 'P1', 'P2', 'P3', 'P4'], days: 0 });
    expect(filterTriageTickets([ticket()], filters, now)).toHaveLength(1);
  });

  it('combines priorities with OR and the date filter with AND without mutating input', () => {
    const tickets = [ticket({ priority: 'P0', updatedAt: '2026-09-16T12:00:00Z' }), ticket({ priority: 'P4', updatedAt: '2026-09-15T12:00:00Z' }), ticket({ priority: 'P1', updatedAt: '2026-09-16T12:00:00Z' }), ticket({ priority: 'P4', updatedAt: '2026-08-01T00:00:00Z' })];
    expect(filterTriageTickets(tickets, { priorities: ['P0', 'P4'], days: 7 }, now)).toEqual(tickets.slice(0, 2));
    expect(tickets).toHaveLength(4);
    expect(filterTriageTickets(tickets, { priorities: [], days: 0 }, now)).toEqual([]);
  });

  it.each([1, 7, 30] as const)('includes the exact rolling %i-day boundary and excludes older/future/missing dates', days => {
    const boundary = now - days * 86_400_000;
    const dates = [boundary, boundary - 1, now, now + 1].map(time => new Date(time).toISOString());
    const tickets = [...dates, undefined, 'bad-date'].map(updatedAt => ticket({ updatedAt }));
    expect(filterTriageTickets(tickets, { priorities: ['P0'], days }, now)).toEqual([tickets[0], tickets[2]]);
  });

  it('handles missing and malformed tickets safely', () => {
    expect(filterTriageTickets(undefined, defaultTriageFilters(), now)).toEqual([]);
    expect(filterTriageTickets([null, {}] as Ticket[], defaultTriageFilters(), now)).toEqual([]);
  });

  it('normalizes persisted state while preserving intentional empty selection', () => {
    expect(parseTriageFilters({ priorities: ['P4', 'P0', 'P0', 'P9'], days: 7 })).toEqual({ priorities: ['P0', 'P4'], days: 7 });
    expect(parseTriageFilters({ priorities: [], days: 0 })).toEqual({ priorities: [], days: 0 });
    expect(parseTriageFilters({ priorities: null, days: '7' })).toEqual(defaultTriageFilters());
    expect(parseTriageFilters(null)).toEqual(defaultTriageFilters());
  });
});
