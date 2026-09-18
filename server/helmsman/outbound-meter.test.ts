import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { createOutboundMeter } from './outbound-meter.ts';

const meters: ReturnType<typeof createOutboundMeter>[] = [];
const publish = (event: string, value: unknown) => channel(`undici:request:${event}`).publish(value);

function setup() {
  let time = Date.parse('2026-09-17T12:00:00Z');
  const meter = createOutboundMeter({ now: () => time });
  meters.push(meter);
  return { meter, advance: (milliseconds: number) => { time += milliseconds; } };
}

afterEach(() => {
  for (const meter of meters.splice(0)) meter.close();
});

describe('outbound request meter', () => {
  it('counts actual request diagnostics, responses, HTTP failures and transport errors', () => {
    const { meter } = setup();
    for (const status of [200, 302, 403, 429, 503]) {
      const request = { origin: 'https://api.github.com' };
      publish('create', { request });
      publish('create', { request });
      publish('headers', { request, response: { statusCode: status } });
      publish('headers', { request, response: { statusCode: status } });
    }
    const failed = { origin: 'https://jira.example.com' };
    publish('create', { request: failed });
    publish('error', { request: failed, error: new Error('private error') });
    publish('error', { request: failed });
    publish('create', { request: { origin: 'https://api.github.com' } });
    expect(meter.snapshot()).toMatchObject({
      inflight: 1,
      completion: 'response_headers',
      totals: { started: 7, completed: 5, errors: 1, status2xx: 1, status3xx: 1, status4xx: 2, status5xx: 1, status403: 1, status429: 1 },
      services: [
        { origin: 'https://api.github.com', inflight: 1, totals: { started: 6, completed: 5 } },
        { origin: 'https://jira.example.com', inflight: 0, totals: { started: 1, errors: 1 } },
      ],
    });
  });

  it('excludes loopback, private, local and non-HTTP requests', () => {
    const { meter } = setup();
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:5173', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.1.1.1', 'http://192.168.1.1', 'http://172.16.4.1', 'http://169.254.1.1', 'http://service.local', 'http://service.internal', 'http://printer', 'file:///tmp/data']) {
      publish('create', { request: { origin } });
    }
    expect(meter.snapshot().totals.started).toBe(0);
  });

  it('expires rolling counts while retaining lifetime totals and current inflight', () => {
    const { meter, advance } = setup();
    publish('create', { request: { origin: 'https://api.github.com' } });
    advance(299_000);
    expect(meter.snapshot().last5min.started).toBe(1);
    advance(1000);
    expect(meter.snapshot()).toMatchObject({ observedSeconds: 300, inflight: 1, totals: { started: 1 }, last5min: { started: 0 } });
    publish('create', { request: { origin: 'https://api.github.com' } });
    expect(meter.snapshot().last5min.started).toBe(1);
  });

  it('retains no credentials, paths, queries, headers, bodies or error text', () => {
    const { meter } = setup();
    const request = { origin: 'https://secret-user:secret-pass@api.github.com/private-path?token=secret-token', path: '/secret-path', headers: { authorization: 'secret-auth' }, body: 'secret-body' };
    publish('create', { request });
    publish('error', { request, error: new Error('secret-error') });
    const snapshot = JSON.stringify(meter.snapshot());
    expect(snapshot).toContain('https://api.github.com');
    expect(snapshot).not.toContain('secret');
    expect(snapshot).not.toContain('private-path');
  });

  it('ignores malformed and uncorrelated diagnostics without breaking requests', () => {
    const { meter } = setup();
    for (const message of [null, undefined, 123, {}, { request: null }, { request: { origin: 123 } }, { request: { origin: 'invalid url' } }]) {
      publish('create', message);
      publish('headers', message);
      publish('error', message);
    }
    publish('headers', { request: {}, response: { statusCode: 200 } });
    const request = { origin: new URL('https://api.github.com') };
    publish('create', { request });
    for (const statusCode of [null, undefined, '200', 100, 999, 200.5]) publish('headers', { request, response: { statusCode } });
    expect(meter.snapshot()).toMatchObject({ inflight: 1, totals: { started: 1, completed: 0, errors: 0 } });
  });

  it('counts body errors after response headers without decrementing inflight twice', () => {
    const { meter } = setup();
    const request = { origin: 'https://api.github.com' };
    publish('create', { request });
    publish('headers', { request, response: { statusCode: 200 } });
    publish('error', { request });
    expect(meter.snapshot()).toMatchObject({ inflight: 0, totals: { started: 1, completed: 1, errors: 1 } });
  });

  it('bounds service cardinality and aggregates excess origins', () => {
    const { meter } = setup();
    for (let i = 0; i < 100; i++) publish('create', { request: { origin: `https://service-${i}.example.com` } });
    const snapshot = meter.snapshot();
    expect(snapshot.services).toHaveLength(64);
    expect(snapshot.services.find(service => service.origin === 'other')?.totals.started).toBe(37);
    expect(snapshot.totals.started).toBe(100);
  });

  it('unsubscribes on close and returns independent snapshots', () => {
    const { meter, advance } = setup();
    publish('create', { request: { origin: 'https://api.github.com' } });
    const snapshot = meter.snapshot();
    snapshot.services[0]!.totals.started = 999;
    expect(meter.snapshot().totals.started).toBe(1);
    meter.close();
    meter.close();
    advance(1000);
    publish('create', { request: { origin: 'https://api.github.com' } });
    expect(meter.snapshot()).toMatchObject({ observedSeconds: 0, totals: { started: 1 } });
  });
});
