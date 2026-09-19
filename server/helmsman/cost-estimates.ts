import type { ProviderUsage, UsageCostEstimate } from '../../src/data/outcomes';

export const COST_ESTIMATE_SOURCE = 'https://developers.openai.com/api/docs/pricing';
export const COST_ESTIMATE_DATE = '2026-09-19';

const STANDARD_SHORT_CONTEXT_RATES = new Map<string, readonly [number, number, number]>([
  ['gpt-6-astra', [10, 1, 50]],
  ['gpt-5.6-sol', [4, 0.4, 20]],
  ['gpt-5.6-terra', [2, 0.2, 12]],
]);

export function estimateUnreportedUsage(usage: ProviderUsage): number | null {
  if (!usage || usage.costUsd !== null || usage.provider !== 'codex' || !usage.model) return null;
  const rates = STANDARD_SHORT_CONTEXT_RATES.get(usage.model);
  if (!rates) return null;
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  if (![inputTokens, cachedInputTokens, outputTokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || inputTokens === null || cachedInputTokens === null || outputTokens === null || cachedInputTokens > inputTokens) return null;
  return ((inputTokens - cachedInputTokens) * rates[0] + cachedInputTokens * rates[1] + outputTokens * rates[2]) / 1_000_000;
}

export function summarizeCostEstimates(reports: ProviderUsage[]): UsageCostEstimate {
  const missing = reports.filter(report => report.costUsd === null);
  const estimates = missing.flatMap(report => {
    const estimate = estimateUnreportedUsage(report);
    return estimate === null ? [] : [estimate];
  });
  return {
    estimatedUnreportedCostUsd: estimates.length ? estimates.reduce((sum, estimate) => sum + estimate, 0) : null,
    estimatedUsageEvents: estimates.length,
    unreportedUsageEvents: missing.length,
  };
}
