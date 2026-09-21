export interface BacklogItem {
  ticketId: string;
  title: string;
  todoId?: string;
  mode?: 'todo';
}

export interface SchedulerDeps {
  canStart: (repo: string, item?: BacklogItem) => boolean;
  fetchTopBacklog: (repo: string) => Promise<BacklogItem | null>;
  launch: (body: BacklogItem & { repo: string }) => void;
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

        const ticket: BacklogItem | null = await this.deps.fetchTopBacklog(repo);
        if (ticket === null) {
          continue;
        }

        if (!this.enabledRepoSet.has(repo) || !this.deps.canStart(repo, ticket)) {
          continue;
        }

        this.deps.launch({
          ...ticket,
          repo,
        });
      } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : String(err);
        this.deps.onLog?.(`Error processing galleon ${repo}: ${message}`);
      }
    }
  }
}
