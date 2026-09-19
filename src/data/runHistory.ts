import type { RunSummary } from './agents';

export const RUN_HISTORY_PAGE_SIZE = 25;

export interface RunHistoryPage {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validRun(value: unknown, repo: string | null): value is RunSummary {
  const run = record(value);
  return run !== null && typeof run.id === 'string' && /^[a-z\d_-]{1,128}$/i.test(run.id)
    && typeof run.repo === 'string' && (!repo || run.repo === repo)
    && typeof run.ticketId === 'string' && typeof run.status === 'string' && typeof run.startedAt === 'string'
    && typeof run.attempt === 'number' && Number.isSafeInteger(run.attempt) && run.attempt >= 0
    && (run.prNumber === null || typeof run.prNumber === 'number' && Number.isSafeInteger(run.prNumber) && run.prNumber > 0)
    && (run.costUsd === null || typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) && run.costUsd >= 0);
}

export async function fetchRunHistory(repo: string | null, offset = 0): Promise<RunHistoryPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('History offset must be a nonnegative integer.');
  const params = new URLSearchParams({ limit: String(RUN_HISTORY_PAGE_SIZE), offset: String(offset) });
  if (repo) params.set('repo', repo);
  const response = await fetch(`/api/runs?${params}`, { signal: AbortSignal.timeout(10_000) });
  const body: unknown = await response.json().catch(() => null);
  const page = record(body);
  if (!response.ok) throw new Error(typeof page?.error === 'string' ? page.error : `Could not load history (${response.status}).`);
  if (!page || page.limit !== RUN_HISTORY_PAGE_SIZE || page.offset !== offset
    || typeof page.total !== 'number' || !Number.isSafeInteger(page.total) || page.total < 0
    || !Array.isArray(page.runs) || page.runs.length > RUN_HISTORY_PAGE_SIZE || page.runs.length > Math.max(0, page.total - offset)
    || !page.runs.every(run => validRun(run, repo))) throw new Error('History response was invalid.');
  return { runs: page.runs, total: page.total, limit: RUN_HISTORY_PAGE_SIZE, offset };
}
