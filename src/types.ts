export type Priority = 'P1' | 'P2' | 'P3';

export type TicketStatus = 'backlog' | 'in-progress' | 'in-review' | 'done';

export interface Ticket {
  id: string;
  title: string;
  priority: Priority;
  status: TicketStatus;
  repo: string;
}

export type StepState = 'done' | 'active';

export interface WorkStep {
  time: string;
  state: StepState;
  text: string;
}

export type PrStatus = 'in-review' | 'merged' | 'changes-requested';

export interface ShippedPr {
  number: number;
  title: string;
  ticketId: string;
  status: PrStatus;
  openedAt: string;
}

export interface ActivityEvent {
  time: string;
  text: string;
  accent: boolean;
}

export interface DailyStats {
  completedToday: number;
  awaitingReview: number;
  avgCycleMinutes: number;
  tokensSpent: number;
  estCostUsd: number;
}
