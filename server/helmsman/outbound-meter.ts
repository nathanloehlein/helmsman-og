import { channel } from 'node:diagnostics_channel';
import { isIP } from 'node:net';

interface RequestCounts {
  started: number;
  completed: number;
  errors: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  status403: number;
  status429: number;
}

interface Service {
  origin: string;
  inflight: number;
  totals: RequestCounts;
  buckets: Map<number, RequestCounts>;
}

function emptyCounts(): RequestCounts {
  return { started: 0, completed: 0, errors: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, status403: 0, status429: 0 };
}

function addCounts(target: RequestCounts, source: RequestCounts): void {
  for (const key of Object.keys(target) as (keyof RequestCounts)[]) target[key] += source[key];
}

function externalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.origin.length > 512) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
    const ipVersion = isIP(host);
    if (ipVersion === 4) {
      const [a = 0, b = 0] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
    } else if (ipVersion === 6) {
      if (host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith('::ffff:')) return null;
    } else if (!host.includes('.')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function createOutboundMeter(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const services = new Map<string, Service>();
  const requests = new WeakMap<object, { service: Service; completed: boolean; errored: boolean }>();
  let closedAt: number | null = null;

  function prune(service: Service, second: number): void {
    for (const key of service.buckets.keys()) if (key <= second - 300 || key > second) service.buckets.delete(key);
  }

  function increment(service: Service, keys: (keyof RequestCounts)[]): void {
    const second = Math.floor(now() / 1000);
    prune(service, second);
    let bucket = service.buckets.get(second);
    if (!bucket) {
      bucket = emptyCounts();
      service.buckets.set(second, bucket);
    }
    for (const key of keys) {
      service.totals[key] += 1;
      bucket[key] += 1;
    }
  }

  function onCreate(message: unknown): void {
    const request = record(record(message)?.request);
    if (!request || requests.has(request)) return;
    const origin = externalOrigin(request.origin);
    if (!origin) return;
    const key = services.has(origin) || services.size < 63 ? origin : 'other';
    let service = services.get(key);
    if (!service) {
      service = { origin: key, inflight: 0, totals: emptyCounts(), buckets: new Map() };
      services.set(key, service);
    }
    requests.set(request, { service, completed: false, errored: false });
    service.inflight += 1;
    increment(service, ['started']);
  }

  function onHeaders(message: unknown): void {
    const payload = record(message);
    const request = record(payload?.request);
    const tracked = request ? requests.get(request) : undefined;
    const status = record(payload?.response)?.statusCode;
    if (!tracked || tracked.completed || tracked.errored || typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) return;
    tracked.completed = true;
    tracked.service.inflight -= 1;
    const keys: (keyof RequestCounts)[] = ['completed'];
    if (status < 300) keys.push('status2xx');
    else if (status < 400) keys.push('status3xx');
    else if (status < 500) keys.push('status4xx');
    else keys.push('status5xx');
    if (status === 403) keys.push('status403');
    if (status === 429) keys.push('status429');
    increment(tracked.service, keys);
  }

  function onError(message: unknown): void {
    const request = record(record(message)?.request);
    const tracked = request ? requests.get(request) : undefined;
    if (!tracked || tracked.errored) return;
    tracked.errored = true;
    if (!tracked.completed) tracked.service.inflight -= 1;
    increment(tracked.service, ['errors']);
  }

  const subscriptions = [
    ['undici:request:create', onCreate],
    ['undici:request:headers', onHeaders],
    ['undici:request:error', onError],
  ] as const;
  const handlers = subscriptions.map(([name, handler]) => {
    const safeHandler = (message: unknown) => {
      try { handler(message); } catch { /* Diagnostics must never interrupt the request being observed. */ }
    };
    channel(name).subscribe(safeHandler);
    return { name, handler: safeHandler };
  });

  return {
    snapshot() {
      const sampledAt = closedAt ?? now();
      const second = Math.floor(sampledAt / 1000);
      const totals = emptyCounts();
      const last5min = emptyCounts();
      let inflight = 0;
      const rows = [...services.values()].map(service => {
        prune(service, second);
        const recent = emptyCounts();
        for (const bucket of service.buckets.values()) addCounts(recent, bucket);
        addCounts(totals, service.totals);
        addCounts(last5min, recent);
        inflight += service.inflight;
        return { origin: service.origin, inflight: service.inflight, totals: { ...service.totals }, last5min: recent };
      });
      return {
        startedAt: new Date(startedAt).toISOString(),
        sampledAt: new Date(sampledAt).toISOString(),
        observedSeconds: Math.max(0, (sampledAt - startedAt) / 1000),
        windowSeconds: 300,
        bucketSeconds: 1,
        completion: 'response_headers' as const,
        inflight,
        totals,
        last5min,
        services: rows.sort((a, b) => b.totals.started - a.totals.started || a.origin.localeCompare(b.origin)),
      };
    },
    close() {
      if (closedAt !== null) return;
      closedAt = now();
      for (const { name, handler } of handlers) channel(name).unsubscribe(handler);
    },
  };
}
