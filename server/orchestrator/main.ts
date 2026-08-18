import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { openDb } from './db';
import { handleApi } from './router';

process.loadEnvFile('.env');

const PORT: number = Number(process.env.ORCHESTRATOR_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const db = openDb(process.env.ORCHESTRATOR_DB ?? join(process.cwd(), '.backlog-runner.sqlite'));

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url: URL = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const body: unknown = req.method === 'POST' ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      dashboard: (repo) => buildDashboardResponse(process.env, new Date(), undefined, repo),
      db,
    });
    if (api) {
      res.writeHead(api.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(api.json));
      return;
    }
    const rel: string = url.pathname === '/' ? '/index.html' : url.pathname;
    const file: string = normalize(join(DIST, rel));
    if (file.startsWith(DIST) && existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })().catch((err: unknown) => {
    res.writeHead(500);
    res.end(String(err));
  });
});

server.listen(PORT, () => process.stdout.write(`orchestrator on :${PORT}\n`));
