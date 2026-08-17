import type { GithubPr, JiraIssue } from './types';
import type { ActivityEvent, Priority, PrStatus, ShippedPr, Ticket, TicketStatus, WorkStep } from '../src/types';

const TICKET_ID_RE: RegExp = /[A-Z][A-Z0-9]+-\d+/;

export function mapPriority(name: string | null): Priority {
  if (!name) return 'P3';
  const upper: string = name.toUpperCase();
  if (upper.startsWith('P1') || upper.includes('HIGHEST') || upper === 'HIGH') return 'P1';
  if (upper.startsWith('P2') || upper.includes('MEDIUM')) return 'P2';
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
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  return 'in-review';
}

export function issueToTicket(issue: JiraIssue, repo: string): Ticket {
  return {
    id: issue.key,
    title: issue.fields.summary,
    priority: mapPriority(issue.fields.priority?.name ?? null),
    status: mapStatus(issue.fields.status.name, issue.fields.status.statusCategory.key),
    repo,
  };
}

export function prToShipped(pr: GithubPr): ShippedPr {
  return {
    number: pr.number,
    title: pr.title,
    ticketId: parseTicketId(pr) ?? '—',
    status: mapPrStatus(pr),
    openedAt: pr.createdAt,
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
      text: `<b>${issue.key}</b> &rarr; ${t.to}`,
      accent: true,
    })),
  );

  const prEvents: ActivityEvent[] = prs.flatMap((pr) => {
    const id: string = parseTicketId(pr) ?? `PR #${pr.number}`;
    const events: ActivityEvent[] = [
      { time: pr.createdAt, text: `opened PR #${pr.number} (${id})`, accent: false },
    ];
    if (pr.mergedAt) {
      events.push({ time: pr.mergedAt, text: `<b>${id}</b> PR #${pr.number} merged`, accent: true });
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      events.push({ time: pr.createdAt, text: `PR #${pr.number} changes requested`, accent: false });
    }
    return events;
  });

  return [...jiraEvents, ...prEvents]
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, ACTIVITY_CAP);
}

export function buildSteps(current: JiraIssue, prs: GithubPr[]): WorkStep[] {
  const transitions: { time: string; to: string }[] = statusTransitions(current);
  const allTransitionSteps: WorkStep[] = transitions.map((t) => ({
    time: t.time,
    state: 'done' as const,
    text: `Transitioned to <b>${t.to}</b>`,
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
