import { describe, expect, it } from 'vitest';
import { renderOutcomesView } from './renderOutcomes';

const opts = { active: 'outcomes' as const, repos: ['org/repo'], selectedRepo: 'org/repo', themeId: 'default', readout: null };
const summary = { window: { from: '2026-01-01', to: '2026-01-30' }, repo: 'org/repo', runs: 1, execution: { succeeded: 1, failed: 0, stopped: 0, running: 0 }, assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 1 }, outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 1 }, knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costCoverage: null, averageCostUsd: null, averageDurationMs: null, runsWithDuration: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, linkedPrs: 1, unknownPrs: 1, stalePrs: 0, unavailablePrs: 0, publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0, costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null, correctionRounds: null, failures: [{ stage: '<script>', count: 1 }], daily: [], recentRuns: [{ runId: 'run_1', repo: 'org/repo', status: 'succeeded' as const, prNumber: null, startedAt: '', durationMs: null, costUsd: null, observedCostUsd: null, assessment: null }] };

describe('renderOutcomesView', () => {
  it('labels baseline estimates separately and discloses incomplete coverage and pricing assumptions', () => {
    const costEstimate = { estimatedUnreportedCostUsd: 13.2, estimatedUsageEvents: 1, unreportedUsageEvents: 2,
      runsWithoutUsage: 1, ratesAsOf: '2026-09-19', rateSource: 'https://developers.openai.com/api/docs/pricing' };
    const html = renderOutcomesView({ summary: { ...summary, costEstimate, observedCostUsd: 2,
      recentRuns: summary.recentRuns.map(run => ({ ...run, costEstimate })) }, days: 30, loading: false, error: null, savingRunId: null }, opts);
    expect(html).toContain('Reported spend</span><b>$2.00');
    expect(html).toContain('$13.20 estimated · 1/2 unpriced records');
    expect(html).toContain('1 run without usage records');
    expect(html).toContain('service tier, long-context requests and cache-write usage are not recorded');
    expect(html).toContain('Estimates do not affect reported spend, per-PR costs or budget caps');
    expect(html).toContain('checked 2026-09-19');
  });
  it('renders unknowns distinctly and escapes external values', () => {
    const html = renderOutcomesView({ summary, days: 30, loading: false, error: null, savingRunId: null }, opts);
    expect(html).toContain('Unknown');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('PR visibility: 1 unknown');
  });

  it('shows partial reported spend while labeling full run and PR costs unknown', () => {
    const mixed = { ...summary, observedCostUsd: 2, costCoverage: 0,
      daily: [{ date: '2026-01-01', runs: 1, succeeded: 1, failed: 0, stopped: 0, running: 0, knownCostUsd: null, observedCostUsd: 2, runsWithKnownCost: 0 }],
      recentRuns: summary.recentRuns.map(run => ({ ...run, observedCostUsd: 2 })) };
    const html = renderOutcomesView({ summary: mixed, days: 30, loading: false, error: null, savingRunId: null }, opts);
    expect(html).toContain('Reported spend</span><b>$2.00');
    expect(html).toContain('0/1 runs fully priced');
    expect(html).toContain('$2.00 reported · total unknown');
    expect(html).toContain('Published PR</span><b>Unknown');
    expect(html).toContain('Per-PR costs require fully priced runs.');
  });
});
