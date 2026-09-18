import type { Priority, Ticket } from '../types';

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

/** Priority order first, original backlog order as the tiebreak — never mutates the input. */
export function sortByPriority(tickets: Ticket[]): Ticket[] {
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort((a, b) => PRIORITY_RANK[a.ticket.priority] - PRIORITY_RANK[b.ticket.priority] || a.index - b.index)
    .map((entry) => entry.ticket);
}
