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
  it.each([
    ['codex', '/openai/v1/responses', 'https://gocaas.example/openai/v1', '/responses'],
    ['codex', '/openai/v1/responses/compact', 'https://gocaas.example/openai/v1/', '/responses/compact'],
    ['claude-code', '/anthropic/v1/messages', 'https://gocaas.example/anthropic', '/v1/messages'],
    ['claude-code', '/anthropic/v1/messages?beta=true', 'https://gocaas.example/anthropic/', '/v1/messages?beta=true'],
  ] as const)('routes %s %s through the configured model upstream', async (provider, path, baseUrl, suffix) => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const modelUpstream = vi.fn(async () => ({ baseUrl, key: 'gocaas-key' }));
    const { gateway, base } = await open({ openaiKey: 'direct-openai', anthropicKey: () => 'direct-anthropic',
      modelUpstream, active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    const response = await request(base, cap.token, path, { method: 'POST', body: '{"model":"test"}',
      headers: { 'anthropic-beta': 'claude-code-20250219' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(modelUpstream).toHaveBeenCalledExactlyOnceWith(provider, 'run_1');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${baseUrl.replace(/\/+$/, '')}${suffix}`, expect.objectContaining({
      method: 'POST', redirect: 'error', headers: provider === 'codex'
        ? { Authorization: 'Bearer gocaas-key', 'content-type': 'application/json' }
        : { 'x-api-key': 'gocaas-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-beta': 'claude-code-20250219' },
    }));
  });

  it.each(['throws', 'empty-key', 'empty-url'] as const)('never falls back to direct providers when model upstream %s', async failure => {
    const fetcher = vi.fn();
    const modelUpstream = vi.fn(async () => {
      if (failure === 'throws') throw new Error('private authentication details');
      return { baseUrl: failure === 'empty-url' ? '' : 'https://gocaas.example', key: failure === 'empty-key' ? ' ' : 'gocaas-key' };
    });
    const { gateway, base } = await open({ openaiKey: 'direct-openai', anthropicKey: () => 'direct-anthropic',
      modelUpstream, active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    for (const path of ['/openai/v1/responses', '/openai/v1/responses/compact', '/anthropic/v1/messages', '/anthropic/v1/messages?beta=true']) {
      const response = await request(base, cap.token, path, { method: 'POST' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Model upstream configuration or authentication is unavailable' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps scoped GitHub reads available independently of model upstream authentication', async () => {
    const fetcher = vi.fn(async () => new Response('[]'));
    const modelUpstream = vi.fn(async (): Promise<{ baseUrl: string; key: string }> => { throw new Error('unavailable'); });
    const { gateway, base } = await open({ openaiKey: '', githubKey: () => 'github-key', modelUpstream,
      active: () => true, scope: () => ({ repo: 'owner/repo', branch: 'work', readOnly: true }), fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    const response = await request(base, cap.token, '/github/repos/owner/repo/pulls/1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(modelUpstream).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/owner/repo/pulls/1', expect.objectContaining({
      redirect: 'error', headers: { Authorization: 'Bearer github-key', Accept: 'application/vnd.github+json' },
    }));
  });

  it('accepts the pinned Claude CLI beta messages request with scoped credentials and validated beta headers', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"type":"message"}', { headers: { 'content-type': 'application/json' } }));
    const { gateway, base } = await open({ openaiKey: 'openai-key', anthropicKey: () => 'host-anthropic-key', active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    const beta = 'claude-code-20250219, interleaved-thinking-2025-05-14';
    const response = await request(base, cap.token, '/anthropic/v1/messages?beta=true', { method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-beta': beta, 'x-api-key': 'guest-key', 'x-extra': 'discard' }, body: '{"model":"claude-sonnet-4-6"}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 'message' });
    expect(fetcher).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages?beta=true', expect.objectContaining({ redirect: 'error',
      headers: { 'x-api-key': 'host-anthropic-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-beta': beta } }));
  });

  it('rejects unapproved Anthropic queries and malformed or oversized beta headers before upstream access', async () => {
    const fetcher = vi.fn();
    const { gateway, base } = await open({ openaiKey: 'key', anthropicKey: () => 'key', active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    for (const suffix of ['?beta=false', '?beta=true&target=evil', '?beta=true&beta=true', '?%62eta=true', '/count_tokens?beta=true']) {
      expect((await request(base, cap.token, `/anthropic/v1/messages${suffix}`, { method: 'POST' })).status).toBe(403);
    }
    for (const beta of ['flag;target=evil', 'flag,,other', 'x'.repeat(129), Array(20).fill('x'.repeat(120)).join(',')]) {
      expect((await request(base, cap.token, '/anthropic/v1/messages?beta=true', { method: 'POST', headers: { 'anthropic-beta': beta } })).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

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
