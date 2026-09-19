import type { OutcomeAssessment, OutcomeSummary } from './outcomes';

export const OUTCOME_WINDOWS = [7, 30, 90, 365] as const;
export type OutcomeWindow = typeof OUTCOME_WINDOWS[number];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validSummary(value: unknown): value is OutcomeSummary {
  const source = record(value);
  const validObservedCost = (item: unknown): boolean => {
    const data = record(item);
    return data !== null && (data.observedCostUsd === null || typeof data.observedCostUsd === 'number'
      && Number.isFinite(data.observedCostUsd) && data.observedCostUsd >= 0);
  };
  return source !== null && typeof source.runs === 'number' && record(source.execution) !== null
    && record(source.assessments) !== null && record(source.outcomes) !== null
    && validObservedCost(source) && Array.isArray(source.daily) && source.daily.every(validObservedCost)
    && Array.isArray(source.recentRuns) && source.recentRuns.every(validObservedCost);
}

export async function fetchOutcomes(repo: string | null, days: OutcomeWindow): Promise<OutcomeSummary> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  const response = await fetch(`/api/outcomes?${params}`, { signal: AbortSignal.timeout(10_000) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = record(body)?.error;
    throw new Error(typeof error === 'string' ? error : `Could not load outcomes (${response.status}).`);
  }
  if (!validSummary(body)) throw new Error('Outcomes response was invalid.');
  return body;
}

export interface AssessmentInput {
  state: OutcomeAssessment['state'];
  outcome: OutcomeAssessment['outcome'];
  summary: string;
  evidence: string[];
  failureStage: string | null;
  correctionRounds: number | null;
}

export async function saveOutcomeAssessment(runId: string, input: AssessmentInput): Promise<OutcomeAssessment> {
  const response = await fetch(`/api/outcomes/${encodeURIComponent(runId)}/assessment`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = record(body)?.error;
    throw new Error(typeof error === 'string' ? error : `Could not save assessment (${response.status}).`);
  }
  const assessment = record(body)?.assessment ?? body;
  if (!record(assessment) || typeof record(assessment)?.runId !== 'string') throw new Error('Assessment response was invalid.');
  return assessment as OutcomeAssessment;
}
