export const ASSESSMENT_STATES = ['complete', 'partial', 'failed', 'not-assessed'] as const;
export const TASK_OUTCOMES = ['achieved', 'partial', 'not-achieved', 'unknown'] as const;

export interface OutcomeAssessment {
  runId: string;
  state: typeof ASSESSMENT_STATES[number];
  outcome: typeof TASK_OUTCOMES[number];
  summary: string;
  evidence: string[];
  failureStage: string | null;
  correctionRounds: number | null;
  updatedAt: string;
}

export interface ProviderUsage {
  runId: string;
  attempt: number;
  eventId: string;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface OutcomePullRequest {
  repo: string;
  number: number;
  published: boolean;
  reviewed: boolean;
  merged: boolean;
  availability?: 'known' | 'stale' | 'unavailable';
}

export interface OutcomeDay {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  stopped: number;
  running: number;
  knownCostUsd: number | null;
  observedCostUsd: number | null;
  runsWithKnownCost: number;
}

export interface OutcomeRun {
  runId: string;
  repo: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  prNumber: number | null;
  startedAt: string;
  durationMs: number | null;
  costUsd: number | null;
  observedCostUsd: number | null;
  assessment: OutcomeAssessment | null;
}

export interface OutcomeSummary {
  window: { from: string; to: string };
  repo: string | null;
  runs: number;
  execution: Record<OutcomeRun['status'], number>;
  assessments: Record<OutcomeAssessment['state'], number>;
  outcomes: Record<OutcomeAssessment['outcome'], number>;
  knownCostUsd: number | null;
  observedCostUsd: number | null;
  runsWithKnownCost: number;
  costCoverage: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
  runsWithDuration: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  linkedPrs: number;
  unknownPrs: number;
  stalePrs: number;
  unavailablePrs: number;
  publishedPrs: number;
  reviewedPrs: number;
  mergedPrs: number;
  costPerPublishedPrUsd: number | null;
  costPerReviewedPrUsd: number | null;
  costPerMergedPrUsd: number | null;
  correctionRounds: number | null;
  failures: Array<{ stage: string; count: number }>;
  daily: OutcomeDay[];
  recentRuns: OutcomeRun[];
}
