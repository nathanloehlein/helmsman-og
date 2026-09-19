import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCampaigns, renderCampaigns, type CampaignsViewState } from './renderCampaigns';
import * as client from './data/campaignClient';

vi.mock('./data/campaignClient', () => ({ fetchCampaigns: vi.fn(), fetchCampaign: vi.fn(), createCampaign: vi.fn(), createCampaignPhase: vi.fn(),
  previewCampaignImport: vi.fn(), confirmCampaignImport: vi.fn(), actOnCampaignPhase: vi.fn(), retryCampaignTask: vi.fn() }));
const campaign = { id: 'cp-1', name: '<img src=x onerror=alert(1)>', repo: 'org/app', workflowRef: 'coding@1', concurrency: 1, createdAt: '2026-09-18T00:00:00Z' };
const phase = { id: 'ph-1', campaignId: 'cp-1', name: 'Canary', position: 0, state: 'draft' as const, createdAt: campaign.createdAt, updatedAt: campaign.createdAt };
const detail = { campaign, phases: [{ phase, tasks: [] }] };
const state = (): CampaignsViewState => ({ repo: 'org/app', list: { campaigns: [campaign], workflows: [{ ref: 'coding@1', name: 'Coding' }] }, detail,
  preview: null, busy: false, error: null, name: '', phaseName: '', concurrency: '1', workflowRef: 'coding@1', imports: {}, confirming: null });
const controllers: Array<{ destroy(): void }> = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.innerHTML = ''; vi.resetAllMocks(); });

describe('campaign interface', () => {
  it('escapes imported content and disables starting an unconfirmed empty phase', () => {
    document.body.innerHTML = renderCampaigns({ ...state(), preview: { id: 'pv-1', campaignId: 'cp-1', phaseId: 'ph-1', digest: 'hash', duplicateCount: 0,
      createdAt: campaign.createdAt, importedAt: null, records: [{ key: null, repo: 'org/app', mode: 'freeform', task: '<script>bad()</script>', ticketId: null, title: null }] } });
    expect(document.querySelector('img,script')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-campaign-action="start"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-campaign-confirm-import]')).not.toBeNull();
  });

  it('loads the selected galleon and previews imported text without confirming or starting it', async () => {
    vi.mocked(client.fetchCampaigns).mockResolvedValue(state().list);
    vi.mocked(client.fetchCampaign).mockResolvedValue(detail);
    vi.mocked(client.previewCampaignImport).mockResolvedValue({ id: 'pv-1', campaignId: 'cp-1', phaseId: 'ph-1', digest: 'hash', duplicateCount: 0,
      createdAt: campaign.createdAt, importedAt: null, records: [{ key: null, repo: 'org/app', mode: 'freeform', task: 'Fix it', ticketId: null, title: null }] });
    const container = document.createElement('main'); document.body.append(container);
    controllers.push(mountCampaigns(container, { repo: () => 'org/app' }));
    await vi.waitFor(() => expect(container.querySelector('[data-campaign-import]')).not.toBeNull());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = '{"task":"Fix it"}'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
    container.querySelector('form[data-campaign-import]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(container.querySelector('[data-campaign-confirm-import]')).not.toBeNull());
    expect(client.previewCampaignImport).toHaveBeenCalledWith('ph-1', 'org/app', 'jsonl', '{"task":"Fix it"}');
    expect(client.confirmCampaignImport).not.toHaveBeenCalled();
    expect(client.actOnCampaignPhase).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-campaign-confirm-import]')!.click();
    await vi.waitFor(() => expect(client.confirmCampaignImport).toHaveBeenCalledWith('pv-1', 'org/app'));
  });

  it('ignores a stale galleon response and cleans up on unmount', async () => {
    let resolve!: (value: ReturnType<typeof state>['list']) => void;
    vi.mocked(client.fetchCampaigns).mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ campaigns: [], workflows: [] });
    const container = document.createElement('main'); document.body.append(container);
    let repo = 'org/app'; const controller = mountCampaigns(container, { repo: () => repo }); controllers.push(controller);
    repo = 'org/other'; await controller.refresh(); resolve(state().list);
    await Promise.resolve(); await Promise.resolve();
    expect(container.textContent).not.toContain(campaign.name);
    expect(client.fetchCampaign).not.toHaveBeenCalled();
    controller.destroy();
  });
});
