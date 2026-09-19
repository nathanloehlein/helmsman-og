import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RunRow } from './db';
import type { OutcomeAssessment, OutcomePullRequest, ProviderUsage } from '../../src/data/outcomes';
import { aggregateOutcomes, openOutcomeStore, OutcomeValidationError, UsageConflictError, type OutcomeStore } from './outcomes';

const from = '2026-09-01T00:00:00.000Z';
const to = '2026-09-04T00:00:00.000Z';
const roots: string[] = [];
const stores: OutcomeStore[] = [];
const createStore = () => {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-outcomes-'));
  roots.push(root);
  const path = join(root, 'runs.sqlite');
  const store = openOutcomeStore(path, () => from);
  stores.push(store);
  return { store, path };
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(id: string, patch: Partial<RunRow> = {}): RunRow {
  return { id, ticketId: 'TASK-1', repo: 'org/app', adapter: 'codex', status: 'succeeded', attempt: 1,
    prNumber: null, startedAt: from, endedAt: '2026-09-01T00:01:00.000Z', costUsd: null, worktreePath: null, ...patch };
}
function report(patch: Partial<OutcomeAssessment> = {}): OutcomeAssessment {
  return { source: 'manual', runId: 'one', state: 'complete', outcome: 'achieved', summary: 'Acceptance criteria verified',
    evidence: ['artifact:checks.json'], failureStage: null, correctionRounds: 0, updatedAt: from, ...patch };
}
function usage(patch: Partial<ProviderUsage> = {}): ProviderUsage {
  return { runId: 'one', attempt: 1, eventId: 'turn-1', provider: 'codex', model: 'example',
    inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, totalTokens: 130, costUsd: null, ...patch };
}
function assessmentInput(patch: Partial<OutcomeAssessment> = {}) {
  const { updatedAt: _updatedAt, ...input } = report(patch);
  return input;
}
function pr(patch: Partial<OutcomePullRequest> = {}): OutcomePullRequest {
  return { repo: 'org/app', number: 1, published: true, reviewed: true, merged: true, ...patch };
}

describe('outcome persistence', () => {
  it('persists assessment evidence and provider usage across connections and scopes reads', () => {
    const { store, path } = createStore();
    store.saveAssessment(assessmentInput());
    store.saveAssessment(assessmentInput({ runId: 'other' }));
    store.recordUsage(usage());
    store.recordUsage(usage({ runId: 'other' }));
    const reopened = openOutcomeStore(path);
    stores.push(reopened);
    expect(reopened.getAssessment('one')).toEqual(report());
    expect(reopened.listAssessments(['one', 'one', 'missing'])).toEqual([report()]);
    expect(reopened.listUsage(['one', 'one'])).toEqual([usage()]);
    expect(reopened.getAssessment('missing')).toBeNull();
    expect(reopened.listAssessments([])).toEqual([]);
  });

  it('updates an assessment without altering usage and deduplicates evidence', () => {
    const { store } = createStore();
    store.recordUsage(usage());
    store.saveAssessment(assessmentInput());
    const changed = store.saveAssessment(assessmentInput({ outcome: 'partial', evidence: ['file:test.ts', 'file:test.ts'] }));
    expect(changed.evidence).toEqual(['file:test.ts']);
    expect(store.getAssessment('one')?.outcome).toBe('partial');
    expect(store.listUsage(['one'])).toEqual([usage()]);
  });

  it('makes usage replay idempotent and rejects conflicting replay instead of changing accounting', () => {
    const { store } = createStore();
    expect(store.recordUsage(usage({ costUsd: 1 }))).toBe(true);
    expect(store.recordUsage(usage({ costUsd: 1 }))).toBe(false);
    expect(() => store.recordUsage(usage({ costUsd: 2 }))).toThrow(UsageConflictError);
    expect(store.recordUsage(usage({ attempt: 2, costUsd: 2 }))).toBe(true);
    expect(store.listUsage(['one']).map(item => item.costUsd)).toEqual([1, 2]);
  });

  it('reports malformed persisted JSON values without nullable property access', () => {
    const { store, path } = createStore();
    const raw = new Database(path);
    try {
      raw.prepare('INSERT INTO outcome_assessments (runId, payload) VALUES (?, ?)').run('one', 'null');
      expect(() => store.getAssessment('one')).toThrow(OutcomeValidationError);
      raw.prepare('INSERT INTO outcome_usage (runId, attempt, eventId, payload) VALUES (?, ?, ?, ?)').run('one', 1, 'broken', '[]');
      expect(() => store.listUsage(['one'])).toThrow(OutcomeValidationError);
    } finally { raw.close(); }
  });

  it.each([null, [], {}, { ...assessmentInput(), state: 'running' },
    { ...assessmentInput(), evidence: [null] }, { ...assessmentInput(), evidence: [] },
    { ...assessmentInput(), evidence: Array(31).fill('file:test.ts') },
    { ...assessmentInput(), summary: 'a'.repeat(4001) }, { ...assessmentInput(), correctionRounds: -1 },
    { ...assessmentInput(), state: 'failed' }, { ...assessmentInput(), unexpected: true },
  ])('rejects malformed or unsupported assessment %j', input => {
    const { store } = createStore();
    expect(() => store.saveAssessment(input)).toThrow(OutcomeValidationError);
    expect(store.getAssessment('one')).toBeNull();
  });

  it.each([null, {}, { ...usage(), attempt: 0 }, { ...usage(), inputTokens: 1.5 },
    { ...usage(), costUsd: NaN }, { ...usage(), costUsd: Infinity }, { ...usage(), provider: '' },
    { ...usage(), eventId: 'a'.repeat(257) }, { ...usage(), cachedInputTokens: -1 },
    { ...usage(), totalTokens: -1 }, { ...usage(), runId: '../../secrets' },
    { ...usage(), inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null },
  ])('rejects invalid provider usage %j', input => {
    const { store } = createStore();
    expect(() => store.recordUsage(input)).toThrow(OutcomeValidationError);
    expect(store.listUsage(['one'])).toEqual([]);
  });
});

describe('outcome aggregation', () => {
  it('does not treat process success as task achievement or unknown spend as zero', () => {
    const result = aggregateOutcomes({ runs: [run('one')], from, to });
    expect(result.execution.succeeded).toBe(1);
    expect(result.outcomes).toEqual({ achieved: 0, partial: 0, 'not-achieved': 0, unknown: 1 });
    expect(result.assessments['not-assessed']).toBe(1);
    expect(result.knownCostUsd).toBeNull();
    expect(result.averageCostUsd).toBeNull();
    expect(result.costCoverage).toBe(0);
    expect(result.averageDurationMs).toBe(60000);
    expect(result.inputTokens).toBeNull();
    expect(result.daily).toHaveLength(3);
    expect(result.daily[1]).toMatchObject({ runs: 0, knownCostUsd: null });
  });

  it('filters by UTC half-open window and case-insensitive galleon before collecting evidence or usage', () => {
    const result = aggregateOutcomes({ runs: [run('one'), run('other', { repo: 'org/other' }),
      run('early', { startedAt: '2026-08-31T23:59:59.999Z' }), run('late', { startedAt: to }), run('one')],
    assessments: [report(), report({ runId: 'other' })], usage: [usage(), usage({ runId: 'other', costUsd: 99 })],
    repo: 'ORG/APP', from, to });
    expect(result.runs).toBe(1);
    expect(result.outcomes.achieved).toBe(1);
    expect(result.knownCostUsd).toBeNull();
    expect(result.inputTokens).toBe(100);
    expect(result.recentRuns.map(item => item.runId)).toEqual(['one']);
  });

  it('sums usage once across attempts and uses legacy cost only without provider records', () => {
    const event = usage({ costUsd: 1 });
    const result = aggregateOutcomes({ runs: [run('one', { costUsd: 500 }), run('legacy', { costUsd: 0 }), run('unknown')],
      usage: [event, event, usage({ attempt: 2, costUsd: 2 })], from, to });
    expect(result.knownCostUsd).toBe(3);
    expect(result.runsWithKnownCost).toBe(2);
    expect(result.costCoverage).toBeCloseTo(2 / 3);
    expect(result.averageCostUsd).toBe(1.5);
    expect(result.inputTokens).toBe(200);
    expect(result.cachedInputTokens).toBe(40);
    expect(result.outputTokens).toBe(60);
    expect(result.totalTokens).toBe(260);
    expect(result.daily[0]?.knownCostUsd).toBe(3);
  });

  it('does not claim a complete run cost from partly priced provider usage', () => {
    const result = aggregateOutcomes({ runs: [run('one', { costUsd: 200 })],
      usage: [usage({ costUsd: 1 }), usage({ eventId: 'turn-2' })], from, to });
    expect(result.knownCostUsd).toBeNull();
    expect(result.observedCostUsd).toBe(1);
    expect(result.daily[0]?.observedCostUsd).toBe(1);
    expect(result.recentRuns[0]?.observedCostUsd).toBe(1);
    expect(result.runsWithKnownCost).toBe(0);
    expect(result.inputTokens).toBe(200);
  });

  it('reports priced portions across providers and retries without inflating complete-cost metrics', () => {
    const paid = usage({ provider: 'claude-code', eventId: 'claude-1', costUsd: 2 });
    const result = aggregateOutcomes({ runs: [run('one', { costUsd: 200, prNumber: 1 }), run('complete', { costUsd: 500 }),
      run('legacy', { costUsd: 4 }), run('unpriced', { costUsd: 50 })],
      usage: [usage(), paid, paid, usage({ attempt: 2, eventId: 'claude-2', provider: 'claude-code', costUsd: 1 }),
        usage({ runId: 'complete', costUsd: 3 }), usage({ runId: 'unpriced' })],
      pullRequests: [{ repo: 'org/repo', number: 1, published: true, reviewed: true, merged: true }], from, to });
    expect(result.observedCostUsd).toBe(10);
    expect(result.knownCostUsd).toBe(7);
    expect(result.averageCostUsd).toBe(3.5);
    expect(result.runsWithKnownCost).toBe(2);
    expect(result.costCoverage).toBe(0.5);
    expect(result.costPerPublishedPrUsd).toBeNull();
    expect(result.costPerReviewedPrUsd).toBeNull();
    expect(result.costPerMergedPrUsd).toBeNull();
    expect(result.daily[0]).toMatchObject({ observedCostUsd: 10, knownCostUsd: 7, runsWithKnownCost: 2 });
    expect(result.recentRuns.find(item => item.runId === 'one')).toMatchObject({ costUsd: null, observedCostUsd: 3 });
    expect(result.recentRuns.find(item => item.runId === 'unpriced')).toMatchObject({ costUsd: null, observedCostUsd: null });
  });

  it('keeps reported zero spend distinct from entirely unpriced usage', () => {
    const result = aggregateOutcomes({ runs: [run('one')], usage: [usage({ costUsd: 0 }), usage({ eventId: 'unknown' })], from, to });
    expect(result.observedCostUsd).toBe(0);
    expect(result.knownCostUsd).toBeNull();
    expect(result.averageCostUsd).toBeNull();
    expect(result.costCoverage).toBe(0);
    expect(result.daily[1]?.observedCostUsd).toBeNull();
  });

  it('counts unique PRs across retries and combines their attributable costs without mixing galleons', () => {
    const result = aggregateOutcomes({ runs: [run('one', { prNumber: 1, costUsd: 2 }),
      run('retry', { prNumber: 1, costUsd: 3 }), run('different', { repo: 'org/other', prNumber: 1, costUsd: 7 })],
    pullRequests: [pr(), pr(), pr({ repo: 'org/other', merged: false }), pr({ number: 99 })], from, to });
    expect(result.publishedPrs).toBe(2);
    expect(result.reviewedPrs).toBe(2);
    expect(result.mergedPrs).toBe(1);
    expect(result.costPerPublishedPrUsd).toBe(6);
    expect(result.costPerReviewedPrUsd).toBe(6);
    expect(result.costPerMergedPrUsd).toBe(5);
    expect(result.unknownPrs).toBe(0);
  });

  it('separates unknown/stale/unavailable PR status and unknown associated cost', () => {
    const result = aggregateOutcomes({ runs: [run('one', { prNumber: 1 }), run('two', { prNumber: 2 }),
      run('three', { prNumber: 3 }), run('four', { prNumber: 4 })],
    pullRequests: [pr(), pr({ number: 2, availability: 'stale' }), pr({ number: 3, availability: 'unavailable' })], from, to });
    expect(result.linkedPrs).toBe(4);
    expect(result.publishedPrs).toBe(1);
    expect(result.unknownPrs).toBe(3);
    expect(result.stalePrs).toBe(1);
    expect(result.unavailablePrs).toBe(1);
    expect(result.costPerMergedPrUsd).toBeNull();
  });

  it('uses the latest assessment, counts correction rounds and identifies failure stages', () => {
    const result = aggregateOutcomes({ runs: [run('one', { status: 'failed' }), run('two', { status: 'running', endedAt: null })],
      assessments: [report({ outcome: 'not-achieved', failureStage: 'review', correctionRounds: 2, updatedAt: to }), report()], from, to });
    expect(result.outcomes['not-achieved']).toBe(1);
    expect(result.outcomes.achieved).toBe(0);
    expect(result.correctionRounds).toBe(2);
    expect(result.failures).toEqual([{ stage: 'review', count: 1 }]);
    expect(result.runsWithDuration).toBe(1);
  });

  it('preserves empty cohorts and excludes invalid dates and negative durations', () => {
    const empty = aggregateOutcomes({ runs: [], from, to });
    expect(empty.costCoverage).toBeNull();
    expect(empty.averageDurationMs).toBeNull();
    expect(empty.costPerPublishedPrUsd).toBeNull();
    const result = aggregateOutcomes({ runs: [run('one', { startedAt: 'invalid' }), run('two', { endedAt: '2020-01-01T00:00:00Z' })], from, to });
    expect(result.runs).toBe(1);
    expect(result.averageDurationMs).toBeNull();
  });

  it('bounds recent detail rows without truncating aggregate totals', () => {
    const result = aggregateOutcomes({ runs: Array.from({ length: 105 }, (_, i) => run(`run-${i}`, { costUsd: 1 })), from, to });
    expect(result.recentRuns).toHaveLength(100);
    expect(result.runs).toBe(105);
    expect(result.knownCostUsd).toBe(105);
  });

  it.each([{ from: to, to: from }, { from: '2026-02-31T00:00:00Z', to },
    { from: '2024-01-01T00:00:00Z', to }, { from: '2026-09-01', to },
  ])('rejects invalid/unbounded windows %j', window => {
    expect(() => aggregateOutcomes({ runs: [], ...window })).toThrow(OutcomeValidationError);
  });

  it('rejects conflicting provider events and malformed assessment records', () => {
    expect(() => aggregateOutcomes({ runs: [run('one')], usage: [usage(), usage({ costUsd: 2 })], from, to })).toThrow(UsageConflictError);
    expect(() => aggregateOutcomes({ runs: [run('one')], assessments: [report({ evidence: [null] as unknown as string[] })], from, to })).toThrow(OutcomeValidationError);
  });
});
