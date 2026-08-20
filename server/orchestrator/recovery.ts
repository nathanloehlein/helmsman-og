import type { Db, RunRow } from './db';

export function recoverOrphanedRuns(db: Db, now: () => string): string[] {
  const orphans: RunRow[] = db.activeRuns();
  const ids: string[] = [];
  for (const row of orphans) {
    const ts: string = now();
    db.updateRun(row.id, { status: 'failed', endedAt: ts });
    db.appendEvent(row.id, 'error', 'run interrupted: orchestrator restarted', ts);
    ids.push(row.id);
  }
  return ids;
}
