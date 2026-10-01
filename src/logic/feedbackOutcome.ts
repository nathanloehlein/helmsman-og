export interface FeedbackOutcome {
  state: 'completed' | 'changes_remaining' | 'awaiting_decision';
  headSha: string;
  summary: string;
}

export function parseFeedbackOutcome(value: unknown): FeedbackOutcome | null {
  if (typeof value === 'string') {
    if (value.length > 16_384) return null;
    try { return parseFeedbackOutcome(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state !== 'completed' && record.state !== 'changes_remaining' && record.state !== 'awaiting_decision') return null;
  if (typeof record.headSha !== 'string' || !/^[a-f\d]{40}$/i.test(record.headSha)) return null;
  if (typeof record.summary !== 'string' || !record.summary.trim() || record.summary.length > 4000) return null;
  return { state: record.state, headSha: record.headSha, summary: record.summary.trim() };
}

export function normalizeFeedbackOutcomeForStatus(outcome: FeedbackOutcome | null, status: string): FeedbackOutcome | null {
  if (outcome?.state === 'completed' && (status === 'failed' || status === 'stopped')) {
    return { ...outcome, state: 'changes_remaining', summary: `Run ${status} before feedback completion was confirmed. ${outcome.summary}`.slice(0, 4000) };
  }
  if (outcome?.state === 'awaiting_decision' && ['succeeded', 'failed', 'stopped'].includes(status)) {
    return { ...outcome, state: 'changes_remaining', summary: `Required decision was not answered before the run ended. ${outcome.summary}`.slice(0, 4000) };
  }
  return outcome;
}
