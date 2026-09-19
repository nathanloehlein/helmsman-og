import Database from 'better-sqlite3';
import type { AgentEvent, AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { OutcomeStore } from './outcomes';

export interface RunTelemetry {
  record(run: RunRow, task: AgentTask, event: AgentEvent, byteOffset: number): number | null;
  complete(run: RunRow): void;
  close(): void;
}

export function openRunTelemetry(path: string, outcomes: OutcomeStore): RunTelemetry {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS run_lifecycle (
    runId TEXT NOT NULL, attempt INTEGER NOT NULL, byteOffset INTEGER NOT NULL,
    kind TEXT NOT NULL, provider TEXT, model TEXT, effort TEXT, stage TEXT, round INTEGER,
    providerEventId TEXT, PRIMARY KEY(runId, attempt, byteOffset)
  )`);
  const insert = sql.prepare(`INSERT OR IGNORE INTO run_lifecycle
    (runId,attempt,byteOffset,kind,provider,model,effort,stage,round,providerEventId) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const latestFailure = sql.prepare("SELECT stage FROM run_lifecycle WHERE runId = ? AND attempt = ? AND kind = 'error' AND stage IS NOT NULL ORDER BY attempt DESC, byteOffset DESC LIMIT 1");
  const rounds = sql.prepare('SELECT MAX(round) AS round FROM run_lifecycle WHERE runId = ?');
  return {
    record(run, task, event, byteOffset) {
      if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error('Invalid log offset for telemetry');
      const provider = event.provider ?? run.adapter.replace(/^pre-pr:/, '');
      const model = event.model ?? task.model ?? null;
      insert.run(run.id, run.attempt, byteOffset, event.kind, provider, model, event.effort ?? task.effort ?? null,
        event.stage ?? null, event.round ?? null, event.eventId ?? null);
      if (event.usage && Object.keys(event.usage).length || event.costUsd !== undefined) {
        outcomes.recordUsage({ runId: run.id, attempt: run.attempt, eventId: `log:${byteOffset}`,
          provider, model, ...event.usage, costUsd: event.costUsd ?? null });
      }
      const usage = outcomes.listUsage([run.id]);
      const costs = usage.flatMap(item => item.costUsd === null ? [] : [item.costUsd]);
      return costs.length ? costs.reduce((sum, value) => sum + value, 0) : run.costUsd;
    },
    complete(run) {
      const existing = outcomes.getAssessment(run.id);
      if (existing && existing.source !== 'telemetry') return;
      const failure = latestFailure.get(run.id, run.attempt) as { stage: string | null } | undefined;
      const corrections = rounds.get(run.id) as { round: number | null } | undefined;
      outcomes.saveAssessment({ runId: run.id, source: 'telemetry', state: 'not-assessed', outcome: 'unknown',
        summary: 'Execution finished; task outcome has not been assessed against evidence.', evidence: [],
        failureStage: run.status === 'failed' ? failure?.stage ?? 'execution' : null,
        correctionRounds: corrections?.round === null || corrections?.round === undefined ? null : Math.max(0, corrections.round - 1) });
    },
    close() { sql.close(); },
  };
}
