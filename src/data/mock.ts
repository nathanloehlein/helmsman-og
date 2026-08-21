import type { ActivityEvent, DailyStats, ShippedPr, Ticket, WorkStep } from '../types';

export interface DashboardSnapshot {
  repo: string;
  queue: Ticket[];
  steps: WorkStep[];
  shipped: ShippedPr[];
  activity: ActivityEvent[];
  stats: DailyStats;
  throughput7d: number[];
}

// Timestamps are offsets from load time so the feed always reads as "just happened"
// regardless of when this prototype is opened. A real data source returns real ISO strings.
const NOW = Date.now();
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);

const REPO = 'platform/webhooks-service';

const QUEUE: Ticket[] = [
  { id: 'DEVX-491', title: 'Bump lodash to patch CVE-2026-4471', priority: 'P1', status: 'backlog', repo: REPO },
  { id: 'DEVX-486', title: 'Add pagination to /accounts endpoint', priority: 'P2', status: 'backlog', repo: REPO },
  { id: 'DEVX-479', title: 'Remove dead feature flag legacy-checkout', priority: 'P3', status: 'backlog', repo: REPO },
  { id: 'DEVX-473', title: 'Extract duplicate date-formatting helper', priority: 'P3', status: 'backlog', repo: REPO },
  { id: 'DEVX-468', title: 'Add integration test for retry queue', priority: 'P3', status: 'backlog', repo: REPO },
  { id: 'DEVX-462', title: 'Cache config lookup in gateway middleware', priority: 'P2', status: 'backlog', repo: REPO },
  { id: 'DEVX-457', title: 'Update Node engines field across services', priority: 'P3', status: 'backlog', repo: REPO },
];

const STEPS: WorkStep[] = [
  { time: minutesAgo(11), state: 'done', text: 'Claimed ticket, transitioned to <b>In Progress</b>' },
  { time: minutesAgo(10), state: 'done', text: 'Explored repo, found dispatcher at <b>lib/dispatcher.ts:118</b>' },
  { time: minutesAgo(7), state: 'done', text: 'Implemented exponential backoff with jitter' },
  { time: minutesAgo(1), state: 'done', text: 'Ran test suite &mdash; <b>14 passed</b>, 0 failed' },
  { time: minutesAgo(0), state: 'active', text: 'Opening PR and linking to ticket&hellip;' },
];

const SHIPPED: ShippedPr[] = [
  { number: 1822, title: 'Fix flaky test in auth middleware', ticketId: 'DEVX-460', status: 'in-review', openedAt: hoursAgo(2) },
  { number: 1810, title: 'Add index to sessions table', ticketId: 'DEVX-455', status: 'merged', openedAt: hoursAgo(25) },
  { number: 1799, title: 'Migrate build script to pnpm', ticketId: 'DEVX-448', status: 'changes-requested', openedAt: hoursAgo(49) },
];

const ACTIVITY: ActivityEvent[] = [
  { time: minutesAgo(0), text: '<b>DEVX-482</b> &rarr; In Review, opening PR #1831', accent: true },
  { time: minutesAgo(1), text: 'vitest run complete &mdash; 14 passed', accent: false },
  { time: minutesAgo(7), text: 'implementing exponential backoff + jitter', accent: false },
  { time: minutesAgo(10), text: 'found <b>lib/dispatcher.ts:118</b>', accent: false },
  { time: minutesAgo(11), text: 'claimed <b>DEVX-482</b>', accent: true },
  { time: hoursAgo(2), text: '<b>DEVX-460</b> &rarr; In Review, PR #1822', accent: true },
  { time: hoursAgo(3), text: 'flaky test isolated to auth middleware retry path', accent: false },
  { time: hoursAgo(4.5), text: '<b>DEVX-455</b> merged by @reviewer', accent: true },
];

const STATS: DailyStats = {
  completedToday: 3,
  awaitingReview: 2,
  avgCycleMinutes: 34,
};

const THROUGHPUT_7D = [1, 2, 1, 3, 2, 3, 3];

/** Swap this for a real fetch against Jira + GitHub REST APIs — the DashboardSnapshot shape is the seam. */
export async function loadDashboard(): Promise<DashboardSnapshot> {
  return {
    repo: REPO,
    queue: QUEUE,
    steps: STEPS,
    shipped: SHIPPED,
    activity: ACTIVITY,
    stats: STATS,
    throughput7d: THROUGHPUT_7D,
  };
}
