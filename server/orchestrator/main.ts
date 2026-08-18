import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { openDb } from './db';
import { handleApi } from './router';
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { startRun } from './runner';
import { claudeCodeAdapter } from './agents/claude-code';
import { createWorktree, removeWorktree } from './worktree';
import type { AgentEvent, AgentHandle } from './agents/adapter';
import type { RunEventRow } from './db';

process.loadEnvFile('.env');

const PORT: number = Number(process.env.ORCHESTRATOR_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const db = openDb(process.env.ORCHESTRATOR_DB ?? join(process.cwd(), '.backlog-runner.sqlite'));
const pm: ProcessManager = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

function launch(body: { ticketId: string; title: string; repo: string }): string {
  const runId: string = randomUUID();
  pm.add(runId, body.repo, () => undefined);
  void startRun(
    { ticketId: body.ticketId, title: body.title, repo: body.repo, jiraBaseUrl: process.env.JIRA_BASE_URL ?? '' },
    {
      db,
      bus,
      adapter: claudeCodeAdapter,
      createWorktree: (repo: string, id: string) => createWorktree(AGENTS_ROOT, repo, id),
      removeWorktree: (repo: string, path: string) => removeWorktree(AGENTS_ROOT, repo, path),
      now: () => new Date().toISOString(),
      genId: () => runId,
      onStart: (handle: AgentHandle) => pm.add(runId, body.repo, () => handle.stop()),
    },
  ).finally(() => pm.remove(runId));
  return runId;
}

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
    const logMatch: RegExpMatchArray | null = url.pathname.match(/^\/api\/agents\/([^/]+)\/log$/);
    if (logMatch && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const events: RunEventRow[] = db.listEvents(logMatch[1]);
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const off: () => void = bus.subscribe(logMatch[1], (ev: AgentEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      req.on('close', off);
      return;
    }
    const body: unknown = req.method === 'POST' ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      dashboard: (repo) => buildDashboardResponse(process.env, new Date(), undefined, repo),
      db,
      canStart: (repo: string) => pm.canStart(repo),
      launch,
      stop: (id: string) => pm.stop(id),
    });
    if (api) {
      res.writeHead(api.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(api.json));
      return;
    }
    const rel: string = url.pathname === '/' ? '/index.html' : url.pathname;
    const file: string = normalize(join(DIST, rel));
    if (file.startsWith(DIST + sep) && existsSync(file)) {
      const buf: Buffer = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })().catch((err: unknown) => {
    process.stderr.write(`request error: ${String(err)}\n`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  });
});

server.listen(PORT, () => process.stdout.write(`orchestrator on :${PORT}\n`));
