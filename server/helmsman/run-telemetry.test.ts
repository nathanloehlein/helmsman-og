import { describe, expect, it } from 'vitest';
import { openOutcomeStore } from './outcomes';
import { openRunTelemetry } from './run-telemetry';
import type { RunRow } from './db';

const task = { repo: 'o/r', ticketId: 'task', title: 'task', jiraBaseUrl: '' };
const row: RunRow = { id: 'run-1', repo: 'o/r', ticketId: 'task', adapter: 'codex', attempt: 1,
  status: 'succeeded', prNumber: null, startedAt: '2026-09-18T00:00:00Z', endedAt: '2026-09-18T00:01:00Z', costUsd: null, worktreePath: null };

describe('run telemetry integration', () => {
  it('replays a logged usage event without doubling cost, including a crash before updating the run row', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes);
    const event = { kind: 'usage' as const, text: 'usage', costUsd: 2, usage: { inputTokens: 12 } };
    expect(telemetry.record(row, task, event, 10)).toBe(2);
    expect(telemetry.record(row, task, event, 10)).toBe(2);
    expect(telemetry.record({ ...row, attempt: 2 }, task, event, 10)).toBe(4);
    expect(outcomes.listUsage([row.id])).toHaveLength(2);
    telemetry.close(); outcomes.close();
  });
  it('keeps unpriced usage unknown and execution success unassessed', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes);
    expect(telemetry.record(row, task, { kind: 'usage', text: 'usage', usage: { outputTokens: 5 }, stage: 'fix', round: 3 }, 0)).toBeNull();
    telemetry.complete(row);
    expect(outcomes.getAssessment(row.id)).toMatchObject({ state: 'not-assessed', outcome: 'unknown', correctionRounds: 2 });
    telemetry.close(); outcomes.close();
  });
  it('preserves human evidence on reattachment/finalization', () => {
    const outcomes = openOutcomeStore(':memory:');
    const telemetry = openRunTelemetry(':memory:', outcomes);
    outcomes.saveAssessment({ runId: row.id, state: 'complete', outcome: 'achieved', summary: 'verified', evidence: ['test report'] });
    telemetry.complete(row);
    expect(outcomes.getAssessment(row.id)?.outcome).toBe('achieved');
    telemetry.close(); outcomes.close();
  });
});
