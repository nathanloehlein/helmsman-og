import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCampaignStore, type CampaignStore } from './campaigns';
import { createCampaignService } from './campaign-service';
import type { Campaign, CampaignPhase, CampaignPreview } from '../../src/data/campaigns';

const stores: CampaignStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openCampaignStore(':memory:'); stores.push(store);
  const config = { repos: ['org/app', 'org/other'], workflows: [{ ref: 'coding@1', name: 'Coding' }] };
  const dispatch = vi.fn(async () => {});
  const service = createCampaignService({ store, configuredRepos: () => config.repos, workflows: () => config.workflows, dispatch });
  const call = (path: string, body?: unknown, scope = 'org/app') => service.handle(path, body === undefined ? 'GET' : 'POST', new URLSearchParams(scope ? { repo: scope } : {}), body);
  return { store, service, config, dispatch, call };
}

describe('campaign API service', () => {
  it('completes create → phase → preview → confirm → start with a saved workflow', async () => {
    const { store, call, dispatch } = setup();
    const created = await call('/api/campaigns', { name: 'Batch', concurrency: 2, workflowRef: 'coding@1' });
    expect(created?.status).toBe(201);
    const { campaign } = created!.json as { campaign: Campaign };
    const phaseResponse = await call(`/api/campaigns/${campaign.id}/phases`, { name: 'Canary' });
    const { phase } = phaseResponse!.json as { phase: CampaignPhase };
    const previewResponse = await call(`/api/campaigns/phases/${phase.id}/preview`, { format: 'csv', content: 'task\nFix validation' });
    const { preview } = previewResponse!.json as { preview: CampaignPreview };
    expect(store.tasks(phase.id)).toEqual([]);
    expect((await call(`/api/campaigns/previews/${preview.id}/confirm`, {}))?.status).toBe(200);
    expect(store.tasks(phase.id)).toHaveLength(1);
    expect((await call(`/api/campaigns/phases/${phase.id}/actions`, { action: 'start' }))?.status).toBe(200);
    expect(store.phase(phase.id)?.state).toBe('running');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('enforces header scope for reads and writes', async () => {
    const { store, call } = setup();
    const campaign = store.create({ name: 'Other', repo: 'org/other', workflowRef: 'coding@1', concurrency: 1 });
    expect((await call(`/api/campaigns/${campaign.id}`))?.status).toBe(409);
    expect((await call(`/api/campaigns/${campaign.id}/phases`, { name: 'Wrong scope' }))?.status).toBe(409);
    expect((await call('/api/campaigns'))?.json).toMatchObject({ campaigns: [] });
    expect((await call('/api/campaigns', { name: 'X', workflowRef: 'coding@1', concurrency: 1 }, ''))?.status).toBe(400);
  });

  it('rechecks configured row galleons when confirming a preview', async () => {
    const { store, config, call } = setup();
    const campaign = store.create({ name: 'Batch', repo: 'org/app', workflowRef: 'coding@1', concurrency: 1 });
    const phase = store.createPhase(campaign.id, { name: 'Canary' });
    const response = await call(`/api/campaigns/phases/${phase.id}/preview`, { format: 'jsonl', content: '{"repo":"org/other","task":"Update"}' });
    const { preview } = response!.json as { preview: CampaignPreview };
    config.repos = ['org/app'];
    expect((await call(`/api/campaigns/previews/${preview.id}/confirm`, {}))?.status).toBe(409);
    expect(store.tasks(phase.id)).toEqual([]);
  });

  it('rejects unknown workflows and untrusted preview fields without dispatch', async () => {
    const { store, call, dispatch } = setup();
    expect((await call('/api/campaigns', { name: 'Batch', workflowRef: 'arbitrary@1', concurrency: 1 }))?.status).toBe(400);
    const campaign = store.create({ name: 'Batch', repo: 'org/app', workflowRef: 'coding@1', concurrency: 1 });
    const phase = store.createPhase(campaign.id, { name: 'Canary' });
    expect((await call(`/api/campaigns/phases/${phase.id}/preview`, { format: 'jsonl', content: '{"task":"x"}', allowedRepos: ['unknown/repo'] }))?.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not intercept unrelated API routes', async () => {
    const { call } = setup(); expect(await call('/api/runs')).toBeNull();
  });
});
