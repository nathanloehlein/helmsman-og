export type CampaignPhaseState = 'draft' | 'running' | 'paused' | 'completed' | 'finished' | 'stopped';
export type CampaignTaskState = 'queued' | 'claiming' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Campaign {
  id: string;
  name: string;
  repo: string;
  workflowRef: string;
  concurrency: number;
  createdAt: string;
}

export interface CampaignPhase {
  id: string;
  campaignId: string;
  name: string;
  position: number;
  state: CampaignPhaseState;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecord {
  key: string | null;
  repo: string;
  mode: 'freeform' | 'ticket';
  task: string | null;
  ticketId: string | null;
  title: string | null;
}

export interface CampaignTask {
  id: string;
  campaignId: string;
  phaseId: string;
  record: CampaignRecord;
  state: CampaignTaskState;
  attempt: number;
  runId: string;
  claimToken: string | null;
  claimedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPreview {
  id: string;
  campaignId: string;
  phaseId: string;
  digest: string;
  records: CampaignRecord[];
  duplicateCount: number;
  createdAt: string;
  importedAt: string | null;
}

export interface CampaignWorkflow { ref: string; name: string }
export interface CampaignList { campaigns: Campaign[]; workflows: CampaignWorkflow[] }
export interface CampaignDetail { campaign: Campaign; phases: Array<{ phase: CampaignPhase; tasks: CampaignTask[] }> }
