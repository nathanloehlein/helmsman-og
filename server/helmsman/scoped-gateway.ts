import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';

export interface GatewayCapability { token: string; runId: string; expiresAt: number }
export interface GatewayScope { repo: string; branch: string; readOnly: boolean }
export interface ScopedGatewayOptions {
  path?: string;
  openaiKey: string | (() => string | undefined);
  anthropicKey?: () => string | undefined;
  githubKey?: () => string | undefined;
  active(runId: string): boolean;
  scope?: (runId: string) => GatewayScope | null;
  clarificationReady?: (runId: string) => boolean;
  push?: (runId: string, scope: GatewayScope, headSha: string) => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createScopedGateway(input: ScopedGatewayOptions) {
  const sql = new Database(input.path ?? ':memory:');
  sql.exec('CREATE TABLE IF NOT EXISTS run_capabilities (hash TEXT PRIMARY KEY, runId TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  async function read(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const bytes = Buffer.from(part);
      size += bytes.length;
      if (size > 10_000_000) throw new Error('Request body too large');
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  }
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  };
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 300_000);
    res.on('close', () => abort.abort());
    try {
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
      const cap = typeof token === 'string' && /^[a-f\d]{64}$/.test(token)
        ? sql.prepare('SELECT runId, expiresAt FROM run_capabilities WHERE hash = ?').get(hash(token)) as { runId: string; expiresAt: number } | undefined : undefined;
      if (!cap || cap.expiresAt <= now() || !input.active(cap.runId)) { reply(res, 401, { error: 'Inactive capability' }); return; }
      const path = req.url ?? '';
      if (path === '/clarification-gate' && req.method === 'GET') {
        reply(res, 200, { ready: input.clarificationReady?.(cap.runId) === true }); return;
      }
      if (path === '/git/push' && req.method === 'POST') {
        const scope = input.scope?.(cap.runId);
        if (!scope || scope.readOnly || !input.push) { reply(res, 403, { error: 'Publication not permitted' }); return; }
        const value: unknown = JSON.parse((await read(req)).toString('utf8'));
        if (!value || typeof value !== 'object' || !('headSha' in value) || typeof value.headSha !== 'string'
          || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(value.headSha) || Object.keys(value).length !== 1) {
          reply(res, 400, { error: 'Provide the exact approved revision' }); return;
        }
        await input.push(cap.runId, scope, value.headSha);
        reply(res, 200, { ok: true }); return;
      }
      let url: string;
      let key: string | undefined;
      let headers: Record<string, string>;
      if (req.method === 'POST' && ['/openai/v1/responses', '/openai/v1/responses/compact'].includes(path)) {
        key = typeof input.openaiKey === 'function' ? input.openaiKey() : input.openaiKey;
        url = `https://api.openai.com${path.slice('/openai'.length)}`;
        headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      } else if (req.method === 'POST' && ['/anthropic/v1/messages', '/anthropic/v1/messages?beta=true'].includes(path)) {
        key = input.anthropicKey?.(); url = `https://api.anthropic.com/v1/messages${path.endsWith('?beta=true') ? '?beta=true' : ''}`;
        headers = { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
        const beta = req.headers['anthropic-beta'];
        if (beta !== undefined) {
          if (typeof beta !== 'string' || beta.length > 2048 || !/^[a-z0-9][a-z0-9-]{0,127}(?:,\s*[a-z0-9][a-z0-9-]{0,127})*$/.test(beta)) {
            reply(res, 400, { error: 'Invalid Anthropic beta header' }); return;
          }
          headers['anthropic-beta'] = beta;
        }
      } else if (req.method === 'GET' && path.startsWith('/github/repos/')) {
        const scope = input.scope?.(cap.runId);
        const prefix = scope ? `/github/repos/${scope.repo}/` : '';
        const suffix = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : '';
        if (!suffix || /%|\\|\.\.|#/.test(suffix) || !/^(?:(?:pulls|issues)(?:\/\d+(?:\/(?:comments|reviews|files|commits))?)?|commits(?:\/[a-zA-Z0-9_.-]+)?|contents(?:\/[^?]*)?|compare\/[a-zA-Z0-9_.-]+)(?:\?[^#]*)?$/.test(suffix)) {
          reply(res, 403, { error: 'Read is outside this run scope' }); return;
        }
        key = input.githubKey?.(); url = `https://api.github.com${path.slice('/github'.length)}`;
        headers = { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' };
      } else { reply(res, 403, { error: 'Operation not permitted' }); return; }
      if (!key) { reply(res, 503, { error: 'Upstream credential is not configured' }); return; }
      const body = req.method === 'POST' ? await read(req) : undefined;
      if (!input.active(cap.runId)) { reply(res, 401, { error: 'Run ended' }); return; }
      const upstream = await fetcher(url, { method: req.method, redirect: 'error', headers, body: body ? new Uint8Array(body) : undefined, signal: abort.signal });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        let size = 0;
        try {
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 100_000_000) throw new Error('Upstream response too large');
            if (!res.write(chunk.value)) await once(res, 'drain', { signal: abort.signal });
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      res.end();
    } catch {
      if (!res.headersSent) reply(res, 502, { error: 'Scoped gateway request failed' });
      else res.destroy();
    } finally { clearTimeout(deadline); }
  }
  return {
    issue(runId: string, ttlMs: number): GatewayCapability {
      if (!/^[a-z\d_-]{1,128}$/i.test(runId) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new Error('Invalid capability');
      const capability = { token: randomBytes(32).toString('hex'), runId, expiresAt: now() + ttlMs };
      sql.prepare('INSERT INTO run_capabilities (hash, runId, expiresAt) VALUES (?, ?, ?)').run(hash(capability.token), runId, capability.expiresAt);
      return capability;
    },
    revoke(token: string) { sql.prepare('DELETE FROM run_capabilities WHERE hash = ?').run(hash(token)); },
    revokeRun(runId: string) { sql.prepare('DELETE FROM run_capabilities WHERE runId = ?').run(runId); },
    server() { return createServer((req, res) => { void handler(req, res); }); },
    close() { sql.close(); },
  };
}
