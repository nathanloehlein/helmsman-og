import type { Priority, Ticket } from '../types';

export const TRIAGE_PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
export const TRIAGE_DATE_OPTIONS = [0, 30, 7, 1] as const;
export interface TriageFilters {
  priorities: Priority[];
  days: typeof TRIAGE_DATE_OPTIONS[number];
}

export function defaultTriageFilters(): TriageFilters {
  return { priorities: [...TRIAGE_PRIORITIES], days: 0 };
}

export function parseTriageFilters(value: unknown): TriageFilters {
  const defaults = defaultTriageFilters();
  if (!value || typeof value !== 'object') return defaults;
  const candidate = value as Partial<TriageFilters>;
  return {
    priorities: Array.isArray(candidate.priorities)
      ? TRIAGE_PRIORITIES.filter(priority => candidate.priorities?.includes(priority)) : defaults.priorities,
    days: TRIAGE_DATE_OPTIONS.find(days => days === candidate.days) ?? defaults.days,
  };
}

export function filterTriageTickets(tickets: Ticket[] | undefined, filters: TriageFilters, now = Date.now()): Ticket[] {
  if (!Array.isArray(tickets)) return [];
  const cutoff = now - filters.days * 86_400_000;
  return tickets.filter(ticket => {
    if (!ticket || !filters.priorities.includes(ticket.priority)) return false;
    if (!filters.days) return true;
    const updated = typeof ticket.updatedAt === 'string' ? Date.parse(ticket.updatedAt) : NaN;
    return Number.isFinite(updated) && updated >= cutoff && updated <= now;
  });
}
