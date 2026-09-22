import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirefoxBridgeControl } from './firefox-bridge';

function setup(options: { running?: boolean; occupied?: boolean; firefox?: boolean; endpoint?: string; exits?: boolean; starts?: boolean } = {}) {
  let running = options.running ?? false;
  const driverRunning = vi.fn(async () => running);
  const portOpen = vi.fn(async (port: number) => port === 4444 ? options.occupied ?? running : options.firefox ?? true);
  const launch = vi.fn(() => { running = options.starts ?? true; return { exited: () => options.exits ?? false }; });
  const wait = vi.fn(async () => {});
  const started = vi.fn();
  const control = createFirefoxBridgeControl(() => options.endpoint ?? 'http://127.0.0.1:4444', { driverRunning, portOpen, launch, wait, started });
  return { control, driverRunning, portOpen, launch, wait, started };
}

afterEach(() => vi.unstubAllGlobals());

describe('Firefox bridge control', () => {
  it('checks running bridge and Firefox independently without starting anything', async () => {
    const { control, launch, started } = setup({ running: true, firefox: false });
    expect(await control.status()).toMatchObject({ status: 'running', bridgeRunning: true, firefoxReady: false, canStart: false });
    await control.start();
    expect(launch).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it.each([
    { firefox: false }, { occupied: true }, { endpoint: 'http://localhost:4445' },
    { endpoint: 'http://[::1]:4444' }, { endpoint: 'https://example.com' },
    { endpoint: 'http://127.0.0.1:4444/path' }, { endpoint: 'http://secret@127.0.0.1:4444' },
  ])('does not launch when prerequisites are unavailable: %j', async options => {
    const { control, launch } = setup(options);
    expect(await control.start()).toMatchObject({ status: 'blocked', canStart: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('never contacts nonlocal configured addresses', async () => {
    const { control, driverRunning, portOpen } = setup({ endpoint: 'http://example.com' });
    await control.status();
    expect(driverRunning).not.toHaveBeenCalled();
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent start clicks and verifies driver readiness', async () => {
    const { control, launch, started } = setup();
    expect(await control.status()).toMatchObject({ status: 'stopped', canStart: true });
    const results = await Promise.all([control.start(), control.start(), control.start()]);
    expect(results.every(value => value.bridgeRunning)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    await control.status();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('reports failed helper launch without leaking process details and allows retry', async () => {
    const { control, launch } = setup({ exits: true, starts: false });
    const result = await control.start();
    expect(result.message).toContain('geckodriver');
    expect(result.canStart).toBe(true);
    await control.start();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('does not launch a second helper while an earlier slow start is alive', async () => {
    const { control, launch } = setup({ starts: false });
    expect((await control.start()).message).toContain('taking longer');
    expect((await control.status()).canStart).toBe(false);
    await control.start();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('resets the cached browser session after a slow owned startup is later confirmed', async () => {
    const { control, driverRunning, started } = setup({ starts: false });
    await control.start();
    expect(started).not.toHaveBeenCalled();
    driverRunning.mockResolvedValue(true);
    await control.status();
    await control.status();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('uses only GET /status and recognizes an existing active WebDriver session', async () => {
    const fetcher = vi.fn(async () => Response.json({ value: { ready: false, message: 'Session already started' } }));
    vi.stubGlobal('fetch', fetcher);
    const control = createFirefoxBridgeControl(() => 'http://localhost:4444', { portOpen: async () => true });
    expect((await control.status()).bridgeRunning).toBe(true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://localhost:4444/status', expect.objectContaining({ redirect: 'error' }));
    expect(fetcher.mock.calls[0]).not.toContainEqual(expect.objectContaining({ method: 'POST' }));
  });

  it.each([null, { value: null }, { value: { ready: 'true' } }, { unrelated: true }])('rejects an unrelated service response %j', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
    const control = createFirefoxBridgeControl(() => 'http://localhost:4444', { portOpen: async () => true });
    expect(await control.status()).toMatchObject({ bridgeRunning: false, canStart: false, status: 'blocked' });
  });
});
