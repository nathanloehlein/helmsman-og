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

export type PrStatus = 'in-review' | 'merged' | 'changes-requested' | 'closed';

export interface ShippedPr {
  number: number;
  title: string;
  ticketId: string;
  status: PrStatus;
  openedAt: string;
  repo?: string;
}

export interface OpenPr {
  number: number;
  title: string;
  repo: string;
  reviewDecision: string;
  draft: boolean;
  createdAt: string;
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
}

export interface BugSla {
  text: string;
  overdue: boolean;
  days: number | null;
}

export interface BugRow {
  key: string;
  title: string;
  priority: string;
  severity: string;
  sla: BugSla;
}

export interface BugOldest {
  key: string;
  ageDays: number;
}

export interface BugP75 {
  days: number | null;
  n: number;
  capped: boolean;
}

export interface BugCard {
  project: string;
  repo: string | null;
  label: string;
  open: number;
  delta: number;
  completed: number;
  pastSla: number;
  oldest: BugOldest | null;
  p75: BugP75;
  rows: BugRow[];
  degraded: boolean;
  jiraBaseUrl: string | null;
}

export interface BugsResponse {
  cards: BugCard[];
  degraded: boolean;
  generatedAt: string;
  latestWindow: string;
  previousWindow: string;
}
