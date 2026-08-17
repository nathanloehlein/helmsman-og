import type { GithubPr, JiraIssue } from './types';
import type { Priority, PrStatus, ShippedPr, Ticket, TicketStatus } from '../src/types';

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
