import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmCampaignImport, fetchCampaign, fetchCampaigns, previewCampaignImport } from './campaignClient';

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => body } as Response);

describe('campaign client', () => {
  it('scopes reads to the selected galleon', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ campaigns: [], workflows: [] })); vi.stubGlobal('fetch', fetcher);
    expect(await fetchCampaigns('org/app')).toEqual({ campaigns: [], workflows: [] });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/campaigns?repo=org%2Fapp');
  });

  it.each([null, {}, { campaigns: [null], workflows: [] }, { campaigns: [], workflows: [null] }])('rejects malformed list %j', async body => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(body)));
    await expect(fetchCampaigns(null)).rejects.toThrow();
  });

  it('rejects malformed nested details and preview records', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response({ campaign: null, phases: [{ phase: null, tasks: [null] }] })));
    await expect(fetchCampaign('cp-1', 'org/app')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response({ preview: { id: 'pv-1', phaseId: 'ph-1', digest: 'x', duplicateCount: 0, records: [null] } })));
    await expect(previewCampaignImport('ph-1', 'org/app', 'jsonl', '{}')).rejects.toThrow();
  });

  it('confirms only the persisted preview ID and preserves server conflict messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'Phase is running' }, false)); vi.stubGlobal('fetch', fetcher);
    await expect(confirmCampaignImport('pv-1', 'org/app')).rejects.toThrow('Phase is running');
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/campaigns/previews/pv-1/confirm?repo=org%2Fapp');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe('{}');
  });
});
