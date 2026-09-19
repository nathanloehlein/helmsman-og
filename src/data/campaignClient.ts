import type { Campaign, CampaignDetail, CampaignList, CampaignPhase, CampaignPreview, CampaignTask } from './campaigns';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identified(value: unknown): value is Record<string, unknown> & { id: string } { return typeof object(value)?.id === 'string'; }
function campaign(value: unknown): value is Campaign {
  const item = object(value);
  return identified(value) && typeof item?.name === 'string' && typeof item.repo === 'string' && typeof item.workflowRef === 'string' && typeof item.concurrency === 'number';
}
function phase(value: unknown): value is CampaignPhase {
  const item = object(value);
  return identified(value) && typeof item?.name === 'string' && typeof item.campaignId === 'string'
    && ['draft', 'running', 'paused', 'completed', 'finished', 'stopped'].includes(String(item.state));
}
function task(value: unknown): value is CampaignTask {
  const item = object(value);
  const record = object(item?.record);
  return identified(value) && typeof item?.runId === 'string' && typeof item.attempt === 'number' && typeof record?.repo === 'string'
    && ['freeform', 'ticket'].includes(String(record.mode)) && (typeof record.task === 'string' || record.task === null)
    && (typeof record.ticketId === 'string' || record.ticketId === null) && (typeof record.title === 'string' || record.title === null)
    && (typeof item.error === 'string' || item.error === null) && ['queued', 'claiming', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(item.state));
}
async function request(path: string, repo: string | null, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${path}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, {
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const value = object(await response.json().catch(() => null));
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `Campaign request failed (${response.status})`);
  if (!value) throw new Error('Invalid campaign response');
  return value;
}
export async function fetchCampaigns(repo: string | null): Promise<CampaignList> {
  const data = await request('/api/campaigns', repo);
  if (!Array.isArray(data.campaigns) || !data.campaigns.every(campaign) || !Array.isArray(data.workflows)
    || !data.workflows.every(item => typeof object(item)?.ref === 'string' && typeof object(item)?.name === 'string')) throw new Error('Invalid campaign list');
  return data as unknown as CampaignList;
}
export async function fetchCampaign(id: string, repo: string | null): Promise<CampaignDetail> {
  const data = await request(`/api/campaigns/${encodeURIComponent(id)}`, repo);
  if (!campaign(data.campaign) || !Array.isArray(data.phases) || !data.phases.every(item => {
    const entry = object(item); return phase(entry?.phase) && Array.isArray(entry?.tasks) && entry.tasks.every(task);
  })) throw new Error('Invalid campaign details');
  return data as unknown as CampaignDetail;
}
export async function createCampaign(repo: string, input: { name: string; concurrency: number; workflowRef: string }): Promise<Campaign> {
  const data = await request('/api/campaigns', repo, input);
  if (!campaign(data.campaign)) throw new Error('Unable to confirm campaign creation'); return data.campaign;
}
export async function createCampaignPhase(campaignId: string, repo: string | null, name: string): Promise<void> {
  const data = await request(`/api/campaigns/${encodeURIComponent(campaignId)}/phases`, repo, { name });
  if (!phase(data.phase)) throw new Error('Unable to confirm phase creation');
}
export async function actOnCampaignPhase(id: string, repo: string | null, action: string): Promise<void> {
  const data = await request(`/api/campaigns/phases/${encodeURIComponent(id)}/actions`, repo, { action });
  if (!phase(data.phase)) throw new Error('Unable to confirm phase action');
}
export async function previewCampaignImport(id: string, repo: string | null, format: string, content: string): Promise<CampaignPreview> {
  const data = await request(`/api/campaigns/phases/${encodeURIComponent(id)}/preview`, repo, { format, content });
  const item = object(data.preview);
  if (!identified(item) || typeof item.phaseId !== 'string' || typeof item.digest !== 'string' || typeof item.duplicateCount !== 'number' || !Array.isArray(item.records)
    || !item.records.every(record => typeof object(record)?.repo === 'string' && ['freeform', 'ticket'].includes(String(object(record)?.mode))
      && (typeof object(record)?.task === 'string' || object(record)?.task === null) && (typeof object(record)?.ticketId === 'string' || object(record)?.ticketId === null))) throw new Error('Invalid import preview');
  return item as unknown as CampaignPreview;
}
export async function confirmCampaignImport(id: string, repo: string | null): Promise<void> {
  const data = await request(`/api/campaigns/previews/${encodeURIComponent(id)}/confirm`, repo, {});
  if (!Array.isArray(data.tasks) || !data.tasks.every(task)) throw new Error('Unable to confirm imported tasks');
}
export async function retryCampaignTask(id: string, repo: string | null): Promise<void> {
  const data = await request(`/api/campaigns/tasks/${encodeURIComponent(id)}/retry`, repo, {});
  if (!task(data.task)) throw new Error('Unable to confirm task retry');
}
