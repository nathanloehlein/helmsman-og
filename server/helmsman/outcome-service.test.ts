import { describe, expect, it, vi } from 'vitest';
import { openDb, type RunRow } from './db';
import { openOutcomeStore } from './outcomes';
import { createOutcomeService } from './outcome-service';
import { handleApi, type RouterDeps } from './router';
import type { PrStatus } from '../github';

const run = (id: string, repo = 'o/r', review = false): RunRow => ({ id, repo, ticketId: 'task', adapter: 'codex', attempt: 1,
  status: 'succeeded', prNumber: 1, startedAt: '2026-09-17T00:00:00Z', endedAt: '2026-09-17T00:01:00Z', costUsd: null, worktreePath: null,
  taskJson: JSON.stringify({ review, ...(review ? { prBranch: 'branch' } : {}) }) });
const pr = { draft: false, merged: true, reviewsAvailable: true, reviews: { approved: 1, changesRequested: 0, commented: 0 } } as PrStatus;

describe('outcome service application entry points', () => {
  it('scopes runs, deduplicates PR lookup, and excludes externally reviewed PRs from authored publication', async () => {
    const db = openDb(':memory:'); const store = openOutcomeStore(':memory:');
    db.insertRun(run('one')); db.insertRun(run('two')); db.insertRun(run('external', 'o/external', true));
    const fetchPr = vi.fn(async () => pr);
    const service = createOutcomeService({ db, store, fetchPr, now: () => Date.parse('2026-09-18T00:00:00Z') });
    const scoped = await service.summary(new URLSearchParams('repo=o/r&days=7'));
    expect(scoped.runs).toBe(2); expect(scoped.publishedPrs).toBe(1); expect(fetchPr).toHaveBeenCalledTimes(1);
    const external = await service.summary(new URLSearchParams('repo=o/external'));
    expect(external.publishedPrs).toBe(0); expect(external.reviewedPrs).toBe(1); expect(external.mergedPrs).toBe(1);
    db.close(); store.close();
  });
  it('reports failed PR reads as unavailable and validates assessment ownership through router', async () => {
    const db = openDb(':memory:'); const store = openOutcomeStore(':memory:'); db.insertRun(run('one'));
    const outcomes = createOutcomeService({ db, store, fetchPr: async () => { throw new Error('offline'); }, now: () => Date.parse('2026-09-18T00:00:00Z') });
    const deps = { outcomes } as RouterDeps;
    const result = await handleApi('GET', '/api/outcomes', new URLSearchParams('days=7'), null, deps);
    expect(result?.json).toMatchObject({ unknownPrs: 1, unavailablePrs: 1, knownCostUsd: null });
    const invalid = await handleApi('PUT', '/api/outcomes/one/assessment', new URLSearchParams(), { runId: 'someone-else' }, deps);
    expect(invalid?.status).toBe(400);
    const saved = await handleApi('PUT', '/api/outcomes/one/assessment', new URLSearchParams(), {
      state: 'complete', outcome: 'achieved', summary: 'verified', evidence: ['test report'], source: 'telemetry',
    }, deps);
    expect(saved?.status).toBe(200); expect(store.getAssessment('one')).toMatchObject({ outcome: 'achieved', source: 'manual' });
    db.close(); store.close();
  });
});
