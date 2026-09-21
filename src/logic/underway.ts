import type { RunSummary } from '../data/agents';
import type { OpenPr, Ticket } from '../types';

export interface UnderwayPrTarget {
  repo: string;
  number: number;
  canRequest: boolean;
}

export interface UnderwayOptions {
  selectedRepo: string | null;
  runs: RunSummary[];
  prs: OpenPr[];
  prsAvailable: boolean;
}

function validRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repo)
    && !['.', '..'].includes(repo.split('/')[1] ?? '');
}

function validNumber(number: unknown): number is number {
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0;
}

export function resolveUnderwayTarget(ticket: Ticket, options: UnderwayOptions): { run: RunSummary | null; prs: UnderwayPrTarget[] } {
  if (!ticket || typeof ticket.id !== 'string' || !ticket.id || !options) return { run: null, prs: [] };
  const selectedRepo = typeof options.selectedRepo === 'string' ? options.selectedRepo.toLowerCase() : null;
  const inScope = (repo: unknown): repo is string => validRepo(repo) && (!selectedRepo || repo.toLowerCase() === selectedRepo);
  const runs = (Array.isArray(options.runs) ? options.runs : []).filter(run => run && typeof run.id === 'string' && run.id
    && run.ticketId === ticket.id && inScope(run.repo));
  const openPrs = options.prsAvailable === true && Array.isArray(options.prs)
    ? options.prs.filter(pr => pr && inScope(pr.repo) && validNumber(pr.number)) : [];
  const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  const owned = new Map(openPrs.map(pr => [key(pr.repo, pr.number), pr]));
  const candidates = new Map<string, UnderwayPrTarget>();
  const addPr = (repo: string, number: number, pr?: OpenPr) => {
    const identity = key(repo, number);
    candidates.set(identity, { repo: pr?.repo ?? repo, number, canRequest: pr?.draft === false });
  };
  for (const run of runs) {
    if (!validNumber(run.prNumber)) continue;
    const pr = owned.get(key(run.repo, run.prNumber));
    if (pr || options.prsAvailable !== true) addPr(run.repo, run.prNumber, pr);
  }
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(ticket.id)) {
    for (const pr of openPrs) {
      if (typeof pr.title === 'string' && pr.title.split(/[^a-zA-Z0-9_-]+/).includes(ticket.id)) addPr(pr.repo, pr.number, pr);
    }
  }
  const prs = [...candidates.values()];
  const repos = new Set([...runs.map(run => run.repo.toLowerCase()), ...prs.map(pr => pr.repo.toLowerCase())]);
  if (!selectedRepo && repos.size > 1) return { run: null, prs };
  const sortedRuns = [...runs].sort((a, b) => {
    if (ticket.status === 'in-progress') {
      const active = Number(b.status === 'running') - Number(a.status === 'running');
      if (active) return active;
    }
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || a.id.localeCompare(b.id);
  });
  return { run: sortedRuns[0] ?? null, prs };
}
