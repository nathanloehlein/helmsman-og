import { jiraDescription } from './jira-description';
import type { GithubPr, JiraHistory, JiraIssue } from './types';
import type { OpenAuthoredPr } from './github';
import type { ActivityEvent, DailyStats, OpenPr, Priority, PrStatus, ShippedPr, Ticket, TicketStatus, WorkStep } from '../src/types';
import type { DashboardSnapshot } from '../src/data/mock';
import { escapeHtml } from '../src/logic/html';

const TICKET_ID_RE: RegExp = /[A-Z][A-Z0-9]+-\d+/;

export function mapPriority(name: string | null): Priority {
  if (typeof name !== 'string' || !name) return 'P3';
  const upper: string = name.trim().toUpperCase();
  const explicit = upper.match(/^(P[0-4])\b/);
  if (explicit) return explicit[1] as Priority;
  if (upper.includes('HIGHEST') || upper === 'HIGH') return 'P1';
  if (upper.includes('MEDIUM')) return 'P2';
  if (upper === 'LOWEST') return 'P4';
  return 'P3';
}

export function mapStatus(name: string, categoryKey: string): TicketStatus {
  const lower: string = name.toLowerCase();
  if (lower.includes('review')) return 'in-review';
  if (lower.includes('progress')) return 'in-progress';
  if (categoryKey === 'done' || lower === 'done') return 'done';
  if (categoryKey === 'indeterminate') return 'in-progress';
  return 'backlog';
}

export function parseTicketId(pr: GithubPr): string | null {
  const fromTitle: RegExpMatchArray | null = pr.title.match(TICKET_ID_RE);
  if (fromTitle) return fromTitle[0];
  const fromBranch: RegExpMatchArray | null = pr.headRef.match(TICKET_ID_RE);
  return fromBranch ? fromBranch[0] : null;
}

export function mapPrStatus(pr: GithubPr): PrStatus {
  if (pr.mergedAt) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  return 'in-review';
}

export function issueToTicket(issue: JiraIssue, repo: string): Ticket {
  const updated = issue.fields.updated;
  const updatedAt = typeof updated === 'string' && Number.isFinite(Date.parse(updated))
    ? new Date(updated).toISOString()
    : undefined;
  return {
    id: issue.key,
    title: issue.fields.summary,
    description: jiraDescription(issue.fields.description),
    priority: mapPriority(issue.fields.priority?.name ?? null),
    status: mapStatus(issue.fields.status.name, issue.fields.status.statusCategory.key),
    repo,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function prToShipped(pr: GithubPr): ShippedPr {
  return {
    number: pr.number,
    title: pr.title,
    ticketId: parseTicketId(pr) ?? '—',
    status: mapPrStatus(pr),
    openedAt: pr.createdAt,
    repo: pr.repo,
  };
}

const ACTIVITY_CAP: number = 12;

function statusTransitions(issue: JiraIssue): { time: string; to: string }[] {
  const histories: JiraHistoryLike[] = issue.changelog?.histories ?? [];
  return histories
    .flatMap((h) =>
      h.items
        .filter((it) => it.field === 'status' && it.toString)
        .map((it) => ({ time: h.created, to: it.toString as string })),
    );
}

type JiraHistoryLike = { created: string; items: { field: string; toString: string | null }[] };

export function buildActivity(activeIssues: JiraIssue[], prs: GithubPr[]): ActivityEvent[] {
  const jiraEvents: ActivityEvent[] = activeIssues.flatMap((issue) =>
    statusTransitions(issue).map((t) => ({
      time: t.time,
      text: `<b>${escapeHtml(issue.key)}</b> &rarr; ${escapeHtml(t.to)}`,
      accent: true,
    })),
  );

  const prEvents: ActivityEvent[] = prs.flatMap((pr) => {
    const id: string = parseTicketId(pr) ?? `PR #${pr.number}`;
    const events: ActivityEvent[] = [
      { time: pr.createdAt, text: `opened PR #${pr.number} (${escapeHtml(id)})`, accent: false },
    ];
    if (pr.mergedAt) {
      events.push({ time: pr.mergedAt, text: `<b>${escapeHtml(id)}</b> PR #${pr.number} merged`, accent: true });
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      events.push({ time: pr.createdAt, text: `PR #${pr.number} changes requested`, accent: false });
    }
    return events;
  });

  return [...jiraEvents, ...prEvents]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, ACTIVITY_CAP);
}

export function buildSteps(current: JiraIssue, prs: GithubPr[]): WorkStep[] {
  const transitions: { time: string; to: string }[] = statusTransitions(current);
  const allTransitionSteps: WorkStep[] = transitions.map((t) => ({
    time: t.time,
    state: 'done' as const,
    text: `Transitioned to <b>${escapeHtml(t.to)}</b>`,
  }));

  const linked: GithubPr | undefined = prs.find((pr) => parseTicketId(pr) === current.key);
  const prStep: WorkStep | undefined = linked
    ? { time: linked.createdAt, state: 'done' as const, text: `Opened <b>PR #${linked.number}</b>` }
    : undefined;

  const steps: WorkStep[] = [...allTransitionSteps, ...(prStep ? [prStep] : [])];

  const stillInProgress: boolean = current.fields.status.name.toLowerCase().includes('progress');
  if (stillInProgress && steps.length > 0) {
    const lastIdx: number = steps.length - 1;
    steps[lastIdx] = { ...steps[lastIdx]!, state: 'active' as const };
  }

  return steps;
}

const DAY_MS: number = 24 * 60 * 60 * 1000;

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isDone(issue: JiraIssue): boolean {
  return mapStatus(issue.fields.status.name, issue.fields.status.statusCategory.key) === 'done';
}

function cycleMinutes(issue: JiraIssue): number | null {
  const histories: JiraHistory[] = issue.changelog?.histories ?? [];
  const start: JiraHistory | undefined = histories.find((h) =>
    h.items.some((it) => it.field === 'status' && (it.toString ?? '').toLowerCase().includes('progress')),
  );
  if (!start || !issue.fields.resolutiondate) return null;
  const ms: number = new Date(issue.fields.resolutiondate).getTime() - new Date(start.created).getTime();
  return ms > 0 ? Math.round(ms / 60000) : null;
}

export function computeStats(activeIssues: JiraIssue[], now: Date): DailyStats {
  const today: string = utcDayKey(now);
  const done: JiraIssue[] = activeIssues.filter(isDone);
  const completedToday: number = done.filter(
    (i) => i.fields.resolutiondate !== null && utcDayKey(new Date(i.fields.resolutiondate)) === today,
  ).length;
  const awaitingReview: number = activeIssues.filter(
    (i) => mapStatus(i.fields.status.name, i.fields.status.statusCategory.key) === 'in-review',
  ).length;
  const cycles: number[] = done.map(cycleMinutes).filter((n): n is number => n !== null);
  const avgCycleMinutes: number = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : 0;
  return { completedToday, awaitingReview, avgCycleMinutes };
}

export function buildThroughput7d(activeIssues: JiraIssue[], now: Date): number[] {
  const buckets: number[] = [0, 0, 0, 0, 0, 0, 0];
  const endDay: number = utcMidnight(now);
  activeIssues.forEach((issue: JiraIssue): void => {
    if (!isDone(issue) || !issue.fields.resolutiondate) return;
    const resolvedDay: number = utcMidnight(new Date(issue.fields.resolutiondate));
    const dayIndex: number = 6 - Math.round((endDay - resolvedDay) / DAY_MS);
    if (dayIndex >= 0 && dayIndex <= 6) buckets[dayIndex]++;
  });
  return buckets;
}

export function openPrToView(pr: OpenAuthoredPr): OpenPr {
  return {
    number: pr.number,
    title: pr.title,
    repo: pr.repo,
    reviewDecision: pr.reviewDecision ?? 'REVIEW_REQUIRED',
    draft: pr.draft,
    createdAt: pr.createdAt,
    ...(pr.comments === undefined ? {} : { comments: pr.comments }),
    ...(pr.reviews === undefined ? {} : { reviews: pr.reviews }),
  };
}

export interface SnapshotInput {
  queueIssues: JiraIssue[];
  activeIssues: JiraIssue[];
  prs: GithubPr[];
  openPrs: OpenAuthoredPr[];
  repo: string;
  now: Date;
}

export function assembleSnapshot(input: SnapshotInput): DashboardSnapshot {
  const { queueIssues, activeIssues, prs, openPrs, repo, now } = input;
  const current: JiraIssue | undefined = activeIssues.find(
    (i) => mapStatus(i.fields.status.name, i.fields.status.statusCategory.key) === 'in-progress',
  );
  return {
    repo,
    queue: queueIssues.map((i) => issueToTicket(i, repo)),
    steps: current ? buildSteps(current, prs) : [],
    shipped: prs.map(prToShipped),
    myOpenPrs: openPrs.map(openPrToView),
    activity: buildActivity(activeIssues, prs),
    stats: computeStats(activeIssues, now),
    throughput7d: buildThroughput7d(activeIssues, now),
  };
}
