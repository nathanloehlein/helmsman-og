import type { BugCard, BugRow, BugSla } from '../types';

export interface AssembleCardInput {
  project: string;
  repo: string | null;
  label: string;
  jiraBaseUrl: string | null;
  now: Date;
  open: number;
  createdLast7d: number;
  completedLast7d: number;
  pastSla: number;
  oldestKey: string | null;
  oldestCreated: string | null;
  rows: BugRow[];
  durations: number[];
  durationsTotal: number;
}

const DAY_MS = 86_400_000;

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function priorityRank(name: string | null): number {
  const m = name ? /^P(\d+)/.exec(name) : null;
  return m ? Number(m[1]) : 999;
}

export function daysUntil(dateIso: string | null, now: Date): number | null {
  if (!dateIso) return null;
  const due = Date.parse(dateIso);
  if (Number.isNaN(due)) return null;
  return Math.round((utcMidnight(new Date(due)) - utcMidnight(now)) / DAY_MS);
}

export function ageDays(fromIso: string, now: Date): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.round((utcMidnight(now) - utcMidnight(new Date(from))) / DAY_MS));
}

export function slaLabel(duedate: string | null, now: Date): BugSla {
  const days = daysUntil(duedate, now);
  if (days === null) return { text: '—', overdue: false, days: null };
  if (days < 0) return { text: `Past SLA by ${-days}d`, overdue: true, days };
  return { text: `SLA in ${days}d`, overdue: false, days };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
}

export function sortBugs(rows: BugRow[]): BugRow[] {
  return [...rows].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    if (a.sla.overdue !== b.sla.overdue) return a.sla.overdue ? -1 : 1;
    const ad = a.sla.days ?? Number.POSITIVE_INFINITY;
    const bd = b.sla.days ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.key.localeCompare(b.key);
  });
}

export function assembleCard(input: AssembleCardInput): BugCard {
  const p75 = percentile(input.durations, 75);
  const rank = (75 / 100) * (input.durations.length - 1);
  const frac = rank - Math.floor(rank);
  const capped = frac !== 0;
  return {
    project: input.project,
    repo: input.repo,
    label: input.label,
    open: input.open,
    delta: input.createdLast7d - input.completedLast7d,
    completed: input.completedLast7d,
    pastSla: input.pastSla,
    oldest: input.oldestKey && input.oldestCreated
      ? { key: input.oldestKey, ageDays: ageDays(input.oldestCreated, input.now) }
      : null,
    p75: {
      days: p75 === null ? null : Math.round(p75 * 10) / 10,
      n: input.durationsTotal,
      capped,
    },
    rows: sortBugs(input.rows),
    degraded: false,
    jiraBaseUrl: input.jiraBaseUrl,
  };
}
