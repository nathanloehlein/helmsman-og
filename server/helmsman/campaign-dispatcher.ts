import type { CampaignRecord, CampaignTask } from '../../src/data/campaigns';
import type { CampaignStore } from './campaigns';

export interface CampaignLaunch extends CampaignRecord {
  runId: string;
  workflowRef: string;
  campaignId: string;
  phaseId: string;
  retryOf?: string;
}
export interface CampaignDispatcherOptions {
  store: CampaignStore;
  canStart(repo: string, record?: CampaignRecord): boolean;
  isRunActive?(runId: string): boolean;
  getRun(runId: string): { status: 'running' | 'succeeded' | 'failed' | 'stopped' } | null;
  launch(task: CampaignLaunch): string | Promise<string>;
  stop(runId: string): unknown | Promise<unknown>;
  now?: () => number;
  claimTtlMs?: number;
}

export function createCampaignDispatcher(options: CampaignDispatcherOptions): { poll(): Promise<void> } {
  const { store } = options;
  const now = options.now ?? Date.now;
  const ttl = options.claimTtlMs ?? 60_000;
  if (!Number.isFinite(ttl) || ttl < 1000) throw new Error('Campaign claim lifetime must be at least one second');
  let pending: Promise<void> | null = null;
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000) || 'Campaign dispatch failed';

  async function reconcile(item: CampaignTask): Promise<void> {
    const run = options.getRun(item.runId);
    if (run) {
      if (run.status === 'running') {
        if (item.claimToken) store.markLaunched(item.id, item.claimToken);
        if (store.phase(item.phaseId)?.state === 'stopped') await options.stop(item.runId);
      } else store.settle(item.id, item.runId, run.status === 'stopped' ? 'cancelled' : run.status);
      return;
    }
    if (item.state === 'claiming' && item.claimToken && item.claimedAt
      && now() - Date.parse(item.claimedAt) >= ttl && !options.isRunActive?.(item.runId) && options.canStart(item.record.repo, item.record)) {
      store.releaseClaim(item.id, item.claimToken, 'Previous dispatch was not recorded; retrying the same run ID');
    }
  }

  async function scan(): Promise<void> {
    for (const item of store.activeTasks()) {
      try { await reconcile(item); }
      catch (error) { if (item.claimToken) store.claimError(item.id, item.claimToken, errorText(error)); }
    }
    store.completePhases();
    for (const candidate of store.queuedTasks()) {
      if (store.phase(candidate.phaseId)?.state !== 'running' || !options.canStart(candidate.record.repo, candidate.record)) continue;
      const item = store.claim(candidate.id);
      if (!item?.claimToken) continue;
      const token = item.claimToken;
      const existing = options.getRun(item.runId);
      if (existing) { await reconcile(item); continue; }
      const campaign = store.get(item.campaignId);
      if (!campaign || store.phase(item.phaseId)?.state !== 'running' || !options.canStart(item.record.repo, item.record)) {
        store.releaseClaim(item.id, token); continue;
      }
      try {
        const launched = await options.launch({ ...item.record, runId: item.runId, workflowRef: campaign.workflowRef, campaignId: item.campaignId, phaseId: item.phaseId,
          ...(item.attempt > 1 ? { retryOf: `${item.id}-${item.attempt - 1}` } : {}) });
        if (launched !== item.runId) throw new Error('Launcher returned a different campaign run ID');
        if (options.getRun(item.runId)) await reconcile(item);
        if (store.phase(item.phaseId)?.state === 'stopped') await options.stop(item.runId);
      } catch (error) {
        store.claimError(item.id, token, errorText(error));
        await reconcile(item);
      }
    }
  }

  return { poll() { pending ??= scan().finally(() => { pending = null; }); return pending; } };
}
