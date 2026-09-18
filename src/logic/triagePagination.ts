import type { Ticket } from '../types';
import { sortByPriority } from './queue';

export const TRIAGE_PAGE_SIZES = [5, 10, 25, 50, 100] as const;
export const DEFAULT_TRIAGE_PAGE_SIZE = 10;
export type TriagePageSize = typeof TRIAGE_PAGE_SIZES[number];
export type TriageColumn = 'backlog' | 'todo' | 'mine';
export type TriagePages = Record<TriageColumn, number>;

export function paginateTriageTickets(tickets: Ticket[], pageSize: TriagePageSize, requestedPage: number) {
  const sorted = sortByPriority(Array.isArray(tickets) ? tickets : []);
  const size = TRIAGE_PAGE_SIZES.find(size => size === pageSize) ?? DEFAULT_TRIAGE_PAGE_SIZE;
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const offset = (page - 1) * size;
  return { tickets: sorted.slice(offset, offset + size), total, start: total ? offset + 1 : 0, end: Math.min(total, offset + size), page, pages };
}
