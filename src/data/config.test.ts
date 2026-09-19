import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, setConfig } from './config';
import type { UiConfig } from './config';

const realFetch: typeof globalThis.fetch | undefined = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch as typeof globalThis.fetch;
});

describe('getConfig', () => {
  it('returns the parsed payload on a 200 response', async () => {
    const payload: UiConfig = { config: { foo: 'bar' }, overridden: ['foo'] };
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await getConfig();

    expect(result).toEqual(payload);
  });

  it('returns null on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await getConfig();

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result = await getConfig();

    expect(result).toBeNull();
  });
});

describe('config response validation', () => {
  it.each([null, [], {}, { config: null, overridden: [] }, { config: [], overridden: [] },
    { config: {}, overridden: null }, { config: {}, overridden: [null] },
    { config: {}, overridden: [], jiraTokenSet: 'false' }, { config: { KEY: {} }, overridden: [] },
    { config: { KEY: [] }, overridden: [] }])('rejects malformed payload %j', async payload => {
    globalThis.fetch = vi.fn(async () => Response.json(payload));
    expect(await getConfig()).toBeNull();
  });

  it('accepts nullable and scalar settings', async () => {
    const payload = { config: { EMPTY: null, ENABLED: false, COUNT: 2, TEXT: '' }, overridden: [], jiraTokenSet: false };
    globalThis.fetch = vi.fn(async () => Response.json(payload));
    expect(await getConfig()).toEqual(payload);
  });

  it('returns null for invalid JSON', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{'));
    expect(await getConfig()).toBeNull();
  });
});

describe('setConfig', () => {
  it.each([null, [], { error: null }, { error: {} }, { error: 42 }])('ignores malformed save errors %j', async payload => {
    globalThis.fetch = vi.fn(async () => Response.json(payload, { status: 400 }));
    expect(await setConfig('key', 'value')).toEqual({ ok: false, error: undefined });
  });

  it('returns ok:true on a 200 response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await setConfig('key', 'value');

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the error message on a 400 response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid key' }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await setConfig('key', 'value');

    expect(result).toEqual({ ok: false, error: 'invalid key' });
  });

  it('returns ok:false when fetch throws', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result: { ok: boolean; error?: string } = await setConfig('key', 'value');

    expect(result).toEqual({ ok: false });
  });
});
