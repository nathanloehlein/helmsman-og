import { createHash } from 'node:crypto';
import type { GithubConfig } from './config';

const TTL_MS = 300_000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;
interface Snapshot { body: string; status: number; headers: [string, string][] }
interface Entry { snapshot: Snapshot; expiresAt: number }

export function createGithubReadCache(fetcher: typeof fetch, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Snapshot>>();
  const blockedUntil = new Map<string, number>();
  let bytes = 0;

  function remove(key: string): void {
    const entry = entries.get(key);
    if (entry) bytes -= Buffer.byteLength(entry.snapshot.body);
    entries.delete(key);
  }

  return async (github: GithubConfig, input: string | URL): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== 'https://api.github.com') throw new Error('Invalid GitHub read URL');
    url.searchParams.sort();
    const identity = createHash('sha256').update(github.token).digest('hex');
    const key = JSON.stringify([identity, github.author, url.href]);
    const bucket = `${identity}:${url.pathname.startsWith('/search/') ? 'search' : 'core'}`;
    const respond = (snapshot: Snapshot) => new Response(snapshot.body, { status: snapshot.status, headers: snapshot.headers });
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) {
      entries.delete(key);
      entries.set(key, cached);
      return respond(cached.snapshot);
    }
    if (cached) remove(key);
    if ((blockedUntil.get(bucket) ?? 0) > now()) throw new Error('GitHub reads paused until the API rate limit resets');
    const existing = pending.get(key);
    if (existing) return respond(await existing);
    if (pending.size >= MAX_ENTRIES) throw new Error('Too many pending GitHub reads');
    const request = (async (): Promise<Snapshot> => {
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      const headers = new Headers(response.headers);
      const body = await response.text();
      const snapshot: Snapshot = { body, status: response.status, headers: [...headers.entries()] };
      if (response.status === 403 || response.status === 429) {
        const remaining = headers.get('x-ratelimit-remaining');
        const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
        const retry = headers.get('retry-after');
        const retryAt = retry && /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry ?? '');
        if (remaining === '0' || response.status === 429 || retry) {
          const until = Math.min(now() + 3_600_000, Math.max(now() + 60_000, Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(reset) ? reset : 0));
          for (const [scope, expiry] of blockedUntil) if (expiry <= now()) blockedUntil.delete(scope);
          if (blockedUntil.size >= MAX_ENTRIES) blockedUntil.delete(blockedUntil.keys().next().value!);
          blockedUntil.set(bucket, until);
        }
      }
      if (response.ok && Buffer.byteLength(body) <= MAX_BYTES) {
        const json: unknown = JSON.parse(body);
        if (json && typeof json === 'object') {
          for (const [entryKey, entry] of entries) if (entry.expiresAt <= now()) remove(entryKey);
          const size = Buffer.byteLength(body);
          while (entries.size >= MAX_ENTRIES || bytes + size > MAX_BYTES) remove(entries.keys().next().value!);
          entries.set(key, { snapshot, expiresAt: now() + TTL_MS });
          bytes += size;
        }
      }
      return snapshot;
    })();
    pending.set(key, request);
    try { return respond(await request); }
    finally { pending.delete(key); }
  };
}

const caches = new WeakMap<typeof fetch, ReturnType<typeof createGithubReadCache>>();

export function cachedGithubRead(github: GithubConfig, url: string | URL): Promise<Response> {
  let cache = caches.get(fetch);
  if (!cache) {
    cache = createGithubReadCache(fetch);
    caches.set(fetch, cache);
  }
  return cache(github, url);
}
