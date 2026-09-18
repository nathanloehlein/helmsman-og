export interface SchedulerDeps {
  canStart: (repo: string) => boolean;
  fetchTopBacklog: (repo: string) => Promise<{ ticketId: string; title: string } | null>;
  launch: (body: { ticketId: string; title: string; repo: string }) => void;
  onLog?: (msg: string) => void;
}

export class AutoClaimScheduler {
  private readonly deps: SchedulerDeps;
  private readonly enabledRepoSet: Set<string> = new Set();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  setEnabled(repo: string, enabled: boolean): void {
    if (enabled) {
      this.enabledRepoSet.add(repo);
    } else {
      this.enabledRepoSet.delete(repo);
    }
  }

  isEnabled(repo: string): boolean {
    return this.enabledRepoSet.has(repo);
  }

  enabledRepos(): string[] {
    return Array.from(this.enabledRepoSet);
  }

  async tick(): Promise<void> {
    const reposSnapshot: string[] = Array.from(this.enabledRepoSet);

    for (const repo of reposSnapshot) {
      try {
        if (!this.deps.canStart(repo)) {
          continue;
        }

        const ticket: { ticketId: string; title: string } | null = await this.deps.fetchTopBacklog(repo);
        if (ticket === null) {
          continue;
        }

        if (!this.deps.canStart(repo)) {
          continue;
        }

        this.deps.launch({
          ticketId: ticket.ticketId,
          title: ticket.title,
          repo,
        });
      } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : String(err);
        this.deps.onLog?.(`Error processing repo ${repo}: ${message}`);
      }
    }
  }
}
