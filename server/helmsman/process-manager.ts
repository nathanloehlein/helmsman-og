export interface RunResources {
  ticketId?: string;
  branch?: string;
  prNumber?: number;
}

export class RunConflictError extends Error {}

interface Entry extends RunResources {
  repo: string;
  stop: () => void;
}

export class ProcessManager {
  private readonly maxConcurrency: number;
  private readonly entries: Map<string, Entry> = new Map();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  canStart(repo: string, resources: RunResources = {}, existingRunId?: string): { ok: true } | { ok: false; reason: string } {
    if (!existingRunId && this.entries.size >= this.maxConcurrency) return { ok: false, reason: 'max concurrency reached' };
    for (const [runId, entry] of this.entries) {
      if (runId === existingRunId) continue;
      if (resources.ticketId && entry.ticketId?.toLowerCase() === resources.ticketId.toLowerCase()) return { ok: false, reason: `a run is already active for ticket ${resources.ticketId}` };
      if (entry.repo.toLowerCase() !== repo.toLowerCase()) continue;
      if (resources.branch && entry.branch === resources.branch) return { ok: false, reason: `a run is already writing branch ${resources.branch}` };
      if (resources.prNumber && entry.prNumber === resources.prNumber) return { ok: false, reason: `a run is already updating PR #${resources.prNumber}` };
    }
    return { ok: true };
  }

  reserve(runId: string, repo: string, stop: () => void, resources: RunResources = {}): void {
    if (this.entries.has(runId)) throw new RunConflictError('This voyage is already active.');
    const gate = this.canStart(repo, resources);
    if (!gate.ok) throw new RunConflictError(gate.reason);
    this.restore(runId, repo, stop, resources);
  }

  updateResources(runId: string, resources: RunResources): void {
    const entry = this.entries.get(runId);
    if (!entry) throw new RunConflictError('The voyage reservation is unavailable.');
    const gate = this.canStart(entry.repo, resources, runId);
    if (!gate.ok) throw new RunConflictError(gate.reason);
    this.entries.set(runId, { repo: entry.repo, stop: entry.stop, ...resources });
  }

  restore(runId: string, repo: string, stop: () => void, resources: RunResources = {}): void {
    this.entries.set(runId, { repo, stop, ...resources });
  }

  remove(runId: string): void {
    this.entries.delete(runId);
  }

  stop(runId: string): boolean {
    const entry: Entry | undefined = this.entries.get(runId);
    if (!entry) return false;
    entry.stop();
    return true;
  }

  hasRun(runId: string): boolean {
    return this.entries.has(runId);
  }

  activeRepos(): string[] {
    return Array.from(this.entries.values()).map((e) => e.repo);
  }

  count(): number {
    return this.entries.size;
  }
}
