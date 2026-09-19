import type { Db, RunRow } from './db';
import type { PrStatus } from '../github';
import { isGithubRepo } from '../pr-lists';
import { aggregateOutcomes, OutcomeValidationError, type OutcomeStore } from './outcomes';
import type { OutcomePullRequest, OutcomeSummary } from '../../src/data/outcomes';

export interface OutcomeService {
  summary(query: URLSearchParams): Promise<OutcomeSummary>;
  assessment(runId: string, input: unknown): unknown;
}

export function createOutcomeService(deps: {
  db: Db;
  store: OutcomeStore;
  fetchPr(repo: string, number: number): Promise<PrStatus | null>;
  now?: () => number;
}): OutcomeService {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: OutcomePullRequest | null }>();
  const inflight = new Map<string, Promise<void>>();
  const authored = (run: RunRow): boolean => {
    try {
      const task: unknown = run.taskJson ? JSON.parse(run.taskJson) : null;
      return Boolean(task && typeof task === 'object' && !('review' in task && task.review) && !('prBranch' in task && task.prBranch));
    } catch { return false; }
  };
  async function refresh(key: string, pr: { repo: string; number: number }): Promise<void> {
    const prior = inflight.get(key);
    if (prior) return prior;
    const work = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([deps.fetchPr(pr.repo, pr.number).catch(() => null),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
        cache.set(key, { at: now(), value: result && result.reviewsAvailable !== false ? {
          ...pr, published: !result.draft, merged: result.merged,
          reviewed: Boolean(result.reviews && result.reviews.approved + result.reviews.changesRequested + result.reviews.commented > 0),
        } : null });
      } finally { if (timer) clearTimeout(timer); }
    })();
    inflight.set(key, work);
    try { await work; } finally { inflight.delete(key); }
  }
  return {
    async summary(query) {
      const repo = query.get('repo');
      if (repo !== null && !isGithubRepo(repo)) throw new OutcomeValidationError('Invalid galleon');
      const days = query.get('days') ?? '30';
      if (!/^(7|30|90|365)$/.test(days)) throw new OutcomeValidationError('Choose 7, 30, 90 or 365 days');
      const to = new Date(now()).toISOString();
      const from = new Date(now() - Number(days) * 86_400_000).toISOString();
      const runs = deps.db.runsInWindow(from, to, repo);
      const prs = new Map(runs.flatMap(run => run.prNumber ? [[`${run.repo.toLowerCase()}#${run.prNumber}`, { repo: run.repo, number: run.prNumber }] as const] : []));
      const missing = [...prs].filter(([key]) => now() - (cache.get(key)?.at ?? -Infinity) > 300_000).slice(0, 20);
      for (let index = 0; index < missing.length; index += 4) {
        await Promise.all(missing.slice(index, index + 4).map(([key, pr]) => refresh(key, pr)));
      }
      if (cache.size > 5000) for (const [key, value] of cache) if (now() - value.at > 300_000) cache.delete(key);
      const authoredPrs = new Set(runs.filter(authored).map(run => `${run.repo.toLowerCase()}#${run.prNumber}`));
      const ids = runs.map(run => run.id);
      return aggregateOutcomes({ runs, assessments: deps.store.listAssessments(ids), usage: deps.store.listUsage(ids),
        pullRequests: [...prs.keys()].flatMap(key => {
          const entry = cache.get(key);
          return entry?.value && now() - entry.at <= 300_000 ? [{ ...entry.value, published: entry.value.published && authoredPrs.has(key) }]
            : [{ ...prs.get(key)!, published: false, reviewed: false, merged: false, availability: entry?.value ? 'stale' as const : 'unavailable' as const }];
        }), from, to, repo });
    },
    assessment(runId, input) {
      if (!deps.db.getRun(runId)) throw new OutcomeValidationError('Voyage not found');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OutcomeValidationError('Provide an assessment');
      if ('runId' in input && input.runId !== runId) throw new OutcomeValidationError('Assessment belongs to another voyage');
      return deps.store.saveAssessment({ ...input, runId, source: 'manual' });
    },
  };
}
