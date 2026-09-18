import { describe, expect, it, vi } from 'vitest';
import { createGithubReadCache } from './github-read-cache';

const github = { token: 'secret-token', author: 'captain', repo: 'org/app' };
const url = 'https://api.github.com/repos/org/app/pulls?state=open';
const response = (body: unknown = [], status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup() {
  let now = 1_000_000;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response([{ number: 1 }]));
  return { fetcher, read: createGithubReadCache(fetcher, () => now), advance: (ms: number) => { now += ms; } };
}

describe('GitHub list read cache', () => {
  it('shares five-minute results and returns independently consumable responses', async () => {
    const { read, fetcher, advance } = setup();
    const first = await read(github, url);
    advance(299_999);
    const second = await read(github, url);
    expect(await first.json()).toEqual([{ number: 1 }]);
    expect(await second.json()).toEqual([{ number: 1 }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(1);
    await read(github, url);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous identical reads and canonicalizes query order', async () => {
    const { read, fetcher } = setup();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => read(github,
      `${url}${i % 2 ? '&page=1&per_page=100' : '&per_page=100&page=1'}`)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await Promise.all(results.map(result => result.json()))).toHaveLength(20);
  });

  it('isolates tokens, authors, repositories, and pages', async () => {
    const { read, fetcher } = setup();
    await read(github, url);
    await read({ ...github, token: 'other' }, url);
    await read({ ...github, author: 'other' }, url);
    await read(github, url.replace('org/app', 'org/other'));
    await read(github, `${url}&page=2`);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('does not retain network failures or unsuccessful responses', async () => {
    const { read, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => response({}, 500));
    await expect(read(github, url)).rejects.toThrow('offline');
    expect((await read(github, url)).status).toBe(500);
    expect((await read(github, url)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retain invalid JSON or invalid envelopes', async () => {
    const { read, fetcher } = setup();
    fetcher.mockImplementationOnce(async () => new Response('invalid')).mockImplementationOnce(async () => response(null));
    await expect(read(github, url)).rejects.toThrow();
    await read(github, url);
    await read(github, url);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('pauses the exhausted core bucket until reset while allowing search and other credentials', async () => {
    const { read, fetcher, advance } = setup();
    fetcher.mockImplementationOnce(async () => response({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1120' }));
    expect((await read(github, url)).status).toBe(403);
    await expect(read(github, `${url}&page=2`)).rejects.toThrow('rate limit');
    await read(github, 'https://api.github.com/search/issues?q=is:pr');
    await read({ ...github, token: 'other' }, url);
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(120_000);
    await read(github, url);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('handles secondary limits and malformed reset headers with a bounded cooldown', async () => {
    const { read, fetcher, advance } = setup();
    fetcher.mockImplementationOnce(async () => response({}, 429, { 'x-ratelimit-reset': 'invalid' }));
    await read(github, url);
    advance(59_999);
    await expect(read(github, url)).rejects.toThrow('rate limit');
    advance(1);
    await read(github, url);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses Retry-After and does not pause on ordinary permission errors', async () => {
    const { read, fetcher, advance } = setup();
    fetcher.mockImplementationOnce(async () => response({}, 403))
      .mockImplementationOnce(async () => response({}, 403, { 'retry-after': '180' }));
    await read(github, url);
    await read(github, url);
    advance(179_999);
    await expect(read(github, url)).rejects.toThrow('rate limit');
    advance(1);
    await read(github, url);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('honors the later primary reset across authors sharing credentials', async () => {
    const { read, fetcher, advance } = setup();
    fetcher.mockImplementationOnce(async () => response({}, 403, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1300', 'retry-after': '60',
    }));
    await read(github, url);
    advance(60_000);
    await expect(read({ ...github, author: 'other' }, url)).rejects.toThrow('rate limit');
    advance(240_000);
    await read({ ...github, author: 'other' }, url);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds entries and evicts the least recently used result', async () => {
    const { read, fetcher } = setup();
    for (let i = 0; i < 128; i++) await read(github, `${url}&page=${i}`);
    await read(github, `${url}&page=0`);
    await read(github, `${url}&page=128`);
    await read(github, `${url}&page=0`);
    expect(fetcher).toHaveBeenCalledTimes(129);
    await read(github, `${url}&page=1`);
    expect(fetcher).toHaveBeenCalledTimes(130);
  });

  it('never sends credentials outside GitHub', async () => {
    const { read, fetcher } = setup();
    await expect(read(github, 'https://example.com/repos/org/app/pulls')).rejects.toThrow('Invalid GitHub');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
