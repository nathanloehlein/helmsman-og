import { describe, expect, it } from 'vitest';
import type { ProviderUsage } from '../../src/data/outcomes';
import { estimateUnreportedUsage, summarizeCostEstimates } from './cost-estimates';

const usage: ProviderUsage = { runId: 'one', attempt: 1, eventId: 'turn-1', provider: 'codex', model: 'gpt-6-astra',
  inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000, totalTokens: 1_100_000, costUsd: null };

describe('Standard short-context API estimates', () => {
  it.each([['gpt-6-astra', 13.2], ['gpt-5.6-sol', 5.28], ['gpt-5.6-terra', 2.84]])('prices %s without double-counting cached input', (model, expected) => {
    expect(estimateUnreportedUsage({ ...usage, model })).toBeCloseTo(expected);
  });

  it.each([{ costUsd: 0 }, { costUsd: 3 }, { provider: 'claude-code' }, { model: 'unknown' }, { model: null },
    { inputTokens: null }, { cachedInputTokens: null }, { outputTokens: null }, { cachedInputTokens: 1_000_001 },
    { inputTokens: -1 }, { outputTokens: Infinity }, { outputTokens: 1.5 },
  ])('keeps unsupported or incomplete usage unknown: %j', patch => {
    expect(estimateUnreportedUsage({ ...usage, ...patch })).toBeNull();
  });

  it('preserves zero estimates and counts records that cannot be estimated', () => {
    expect(summarizeCostEstimates([{ ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      { ...usage, model: null }, { ...usage, costUsd: 5 }])).toEqual({
      estimatedUnreportedCostUsd: 0, estimatedUsageEvents: 1, unreportedUsageEvents: 2,
    });
    expect(summarizeCostEstimates([])).toEqual({ estimatedUnreportedCostUsd: null, estimatedUsageEvents: 0, unreportedUsageEvents: 0 });
  });
});
