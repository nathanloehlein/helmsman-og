import type { Priority, Ticket } from '../types';

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

/** Priority order first, original backlog order as the tiebreak — never mutates the input. */
export function sortByPriority(tickets: Ticket[]): Ticket[] {
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort((a, b) => PRIORITY_RANK[a.ticket.priority] - PRIORITY_RANK[b.ticket.priority] || a.index - b.index)
    .map((entry) => entry.ticket);
}
