import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScopedGateway } from './scoped-gateway';

const servers: Array<ReturnType<ReturnType<typeof createScopedGateway>['server']>> = [];
const gateways: Array<ReturnType<typeof createScopedGateway>> = [];
const roots: string[] = [];

async function open(options: Parameters<typeof createScopedGateway>[0]) {
  const gateway = createScopedGateway(options); gateways.push(gateway);
  const server = gateway.server(); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { gateway, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, token: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  gateways.splice(0).forEach(gateway => gateway.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('scoped gateway', () => {
  it('replaces inbound credentials, fixes the upstream origin, and streams the response', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('first')); controller.enqueue(new TextEncoder().encode(' second')); controller.close(); } }), { status: 201, headers: { 'content-type': 'text/plain' } }));
    const { gateway, base } = await open({ openaiKey: 'actual-key', active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 1_000);
    const response = await request(base, cap.token, '/openai/v1/responses', { method: 'POST', headers: { authorization: 'Bearer attacker', 'x-api-key': 'attacker', 'x-extra': 'discard-me' }, body: '{"model":"gpt"}' });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('first second');
    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer actual-key', 'content-type': 'application/json' } }));
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('x-extra');
  });

  it('denies invalid, revoked, expired, inactive, and credentialless capabilities without upstream access', async () => {
    let clock = 1_000;
    const fetcher = vi.fn();
    const { gateway, base } = await open({ openaiKey: () => undefined, active: id => id === 'run_active', now: () => clock, fetcher: fetcher as typeof fetch });
    const active = gateway.issue('run_active', 10);
    const expired = gateway.issue('run_active', 1);
    const inactive = gateway.issue('run_inactive', 10);
    const revoked = gateway.issue('run_active', 10); gateway.revoke(revoked.token); clock += 2;

    for (const token of ['f'.repeat(64), expired.token, inactive.token, revoked.token]) {
      expect((await request(base, token, '/openai/v1/responses', { method: 'POST' })).status).toBe(401);
    }
    expect((await request(base, active.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks GitHub cross-repository, traversal, encoded, and merge reads', async () => {
    const fetcher = vi.fn();
    const { gateway, base } = await open({ openaiKey: 'key', githubKey: () => 'github-key', active: () => true, scope: () => ({ repo: 'owner/repo', branch: 'work', readOnly: false }), fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 1_000);
    for (const path of ['/github/repos/other/repo/pulls', '/github/repos/owner/repo/contents/../secrets', '/github/repos/owner/repo/contents/%2e%2e/secrets', '/github/repos/owner/repo/pulls/1/merge']) {
      expect((await request(base, cap.token, path)).status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('permits only an exact SHA push callback for a writable scope', async () => {
    const push = vi.fn(async () => {});
    const { gateway, base } = await open({ openaiKey: 'key', active: () => true, scope: () => ({ repo: 'owner/repo', branch: 'work', readOnly: false }), push });
    const cap = gateway.issue('run_1', 1_000);
    const headSha = 'a'.repeat(40);
    expect((await request(base, cap.token, '/git/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha }) })).status).toBe(200);
    expect(push).toHaveBeenCalledWith('run_1', { repo: 'owner/repo', branch: 'work', readOnly: false }, headSha);
    expect((await request(base, cap.token, '/git/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha, extra: true }) })).status).toBe(400);
  });

  it('persists and revokes capabilities across gateway reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scoped-gateway-')); roots.push(root);
    const path = join(root, 'gateway.sqlite');
    const first = createScopedGateway({ path, openaiKey: 'key', active: () => true });
    const cap = first.issue('run_1', 1_000); first.close();
    const { gateway, base } = await open({ path, openaiKey: 'key', active: () => true, fetcher: (async () => new Response('ok')) as typeof fetch });
    expect((await request(base, cap.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(200);
    gateway.revokeRun('run_1');
    expect((await request(base, cap.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(401);
  });
});
