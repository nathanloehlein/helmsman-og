import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOutcomes, saveOutcomeAssessment } from './outcomeClient';

const summary = { window: { from: '2026-01-01', to: '2026-01-30' }, repo: null, runs: 1, observedCostUsd: null, execution: {}, assessments: {}, outcomes: {}, daily: [], recentRuns: [] };

afterEach(() => vi.unstubAllGlobals());

describe('outcomeClient', () => {
  it('validates estimate amounts, coverage and source metadata without changing reported spend', async () => {
    const costEstimate = { estimatedUnreportedCostUsd: 1.25, estimatedUsageEvents: 1, unreportedUsageEvents: 2,
      runsWithoutUsage: 0, ratesAsOf: '2026-09-19', rateSource: 'https://developers.openai.com/api/docs/pricing' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...summary, costEstimate }))));
    await expect(fetchOutcomes(null, 7)).resolves.toMatchObject({ observedCostUsd: null, costEstimate });
    for (const patch of [{ estimatedUnreportedCostUsd: -1 }, { estimatedUsageEvents: 3 }, { unreportedUsageEvents: 1.5 },
      { estimatedUnreportedCostUsd: null }, { runsWithoutUsage: -1 }, { ratesAsOf: null }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...summary, costEstimate: { ...costEstimate, ...patch } }))));
      await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
    }
  });
  it('scopes and validates summary requests', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify(summary));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOutcomes('org/repo', 30)).resolves.toMatchObject({ runs: 1 });
    expect(String(calls[0]?.[0])).toBe('/api/outcomes?days=30&repo=org%2Frepo');
  });

  it('rejects malformed or failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })));
    await expect(fetchOutcomes(null, 7)).rejects.toThrow('Unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
  });

  it('retains partial reported spend and rejects invalid reported amounts', async () => {
    const mixed = { ...summary, observedCostUsd: 2, knownCostUsd: null, daily: [{ observedCostUsd: 2 }], recentRuns: [{ observedCostUsd: 2, costUsd: null }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mixed))));
    await expect(fetchOutcomes(null, 7)).resolves.toMatchObject({ observedCostUsd: 2, knownCostUsd: null, recentRuns: [{ observedCostUsd: 2, costUsd: null }] });
    for (const invalid of [{ ...mixed, observedCostUsd: -1 }, { ...mixed, daily: [null] }, { ...mixed, recentRuns: [{ observedCostUsd: '2' }] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(invalid))));
      await expect(fetchOutcomes(null, 7)).rejects.toThrow('invalid');
    }
  });

  it('saves the complete assessment payload', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ assessment: { runId: 'run_1' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await saveOutcomeAssessment('run_1', { state: 'complete', outcome: 'achieved', summary: 'Done', evidence: ['PR #1'], failureStage: null, correctionRounds: 0 });
    expect(calls[0]?.[0]).toBe('/api/outcomes/run_1/assessment');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ outcome: 'achieved', evidence: ['PR #1'] });
  });
});
