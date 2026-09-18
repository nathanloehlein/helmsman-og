interface Entry {
  repo: string;
  stop: () => void;
}

export class ProcessManager {
  private readonly maxConcurrency: number;
  private readonly entries: Map<string, Entry> = new Map();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  canStart(repo: string): { ok: true } | { ok: false; reason: string } {
    if (this.entries.size >= this.maxConcurrency) return { ok: false, reason: 'max concurrency reached' };
    for (const entry of this.entries.values()) {
      if (entry.repo.toLowerCase() === repo.toLowerCase()) return { ok: false, reason: `a run is already active for ${repo}` };
    }
    return { ok: true };
  }

  add(runId: string, repo: string, stop: () => void): void {
    this.entries.set(runId, { repo, stop });
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
