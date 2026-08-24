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

    const result: UiConfig = await getConfig();

    expect(result).toEqual(payload);
  });

  it('returns an empty config on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result: UiConfig = await getConfig();

    expect(result).toEqual({ config: {}, overridden: [] });
  });

  it('returns an empty config when fetch throws', async () => {
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result: UiConfig = await getConfig();

    expect(result).toEqual({ config: {}, overridden: [] });
  });
});

describe('setConfig', () => {
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
