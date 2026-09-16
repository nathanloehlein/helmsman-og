import type { Db, RunRow } from './db';

export interface RecoverDeps {
  reattach: (row: RunRow) => Promise<void>;
}

export async function recoverRuns(db: Db, deps: RecoverDeps): Promise<{ reattached: string[]; failed: string[] }> {
  const rows: RunRow[] = db.reattachableRuns();
  const reattached: string[] = [];
  for (const row of rows) {
    try {
      await deps.reattach(row);
      reattached.push(row.id);
    } catch {
      continue;
    }
  }
  return { reattached, failed: [] };
}
