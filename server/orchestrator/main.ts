import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildDashboardResponse } from '../dashboard-endpoint';
import type { AppConfig } from '../config';
import { openDb } from './db';
import { recoverOrphanedRuns } from './recovery';
import { handleApi } from './router';
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { startRun } from './runner';
import { claudeCodeAdapter } from './agents/claude-code';
import { commandAdapter } from './agents/command';
import { createWorktree, discoverRepoDirs, listAgentWorktrees, removeWorktree, removeWorktreeAt, repoBasename, sweepOrphanedWorktrees } from './worktree';
import { makeJiraActions, type JiraActions } from './jira-actions';
import { findPrNumberByBranch } from '../github';
import { AutoClaimScheduler } from './scheduler';
import { ConfigStore, publicConfig } from './config-store';
import { fetchQueueIssues, fetchIssueSummary } from '../jira';
import type { AgentAdapter, AgentEvent, AgentHandle } from './agents/adapter';
import type { RunEventRow } from './db';
import type { JiraIssue } from '../types';

process.loadEnvFile('.env');

const PORT: number = Number(process.env.ORCHESTRATOR_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const db = openDb(process.env.ORCHESTRATOR_DB ?? join(process.cwd(), '.backlog-runner.sqlite'));
const pm: ProcessManager = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();
const configStore: ConfigStore = new ConfigStore(process.env, db);
const startupCfg: AppConfig = configStore.current();

try {
  const recovered: string[] = recoverOrphanedRuns(db, () => new Date().toISOString());
  if (recovered.length > 0) process.stdout.write(`recovered ${recovered.length} interrupted run(s)\n`);
} catch (err: unknown) {
  process.stderr.write(`run recovery failed: ${String(err)}\n`);
}

try {
  const repos: string[] = [...Object.keys(startupCfg.repoProjectMap), ...(startupCfg.github?.repo ? [startupCfg.github.repo] : [])];
  const configuredDirs: string[] = repos.map((repo: string) => join(AGENTS_ROOT, repoBasename(repo)));
  const discoveredDirs: string[] = await discoverRepoDirs(AGENTS_ROOT);
  const repoDirs: string[] = [...new Set([...configuredDirs, ...discoveredDirs])];
  if (repoDirs.length > 0) {
    const removed: string[] = await sweepOrphanedWorktrees({
      listAgentWorktrees,
      remove: removeWorktreeAt,
      isActiveRunId: (id: string) => pm.hasRun(id),
      repoDirs,
    });
    if (removed.length > 0) process.stdout.write(`swept ${removed.length} orphaned worktree(s)\n`);
  }
} catch (err: unknown) {
  process.stderr.write(`worktree sweep failed: ${String(err)}\n`);
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

function launch(body: { ticketId?: string; title?: string; repo: string; task?: string }): string {
  const runId: string = randomUUID();
  const cfg: AppConfig = configStore.current();
  const control: { stopped: boolean; handle: AgentHandle | null } = { stopped: false, handle: null };
  pm.add(runId, body.repo, () => {
    control.stopped = true;
    control.handle?.stop();
  });
  const adapter: AgentAdapter =
    cfg.agentAdapter === 'command' && cfg.agentCmd ? commandAdapter(cfg.agentCmd) : claudeCodeAdapter;
  if (cfg.agentAdapter === 'command' && !cfg.agentCmd) {
    process.stderr.write('AGENT_ADAPTER=command but AGENT_CMD is empty; using claude-code\n');
  }
  const jira: JiraActions | null = cfg.jira ? makeJiraActions(cfg.jira) : null;
  void (async (): Promise<void> => {
    const ticketId: string = body.ticketId ?? 'freeform';
    const fetchedTitle: string | null =
      !body.title && body.ticketId && cfg.jira
        ? await fetchIssueSummary(cfg.jira, body.ticketId).catch((): null => null)
        : null;
    const title: string = body.title ?? fetchedTitle ?? ticketId;
    await startRun(
      { ticketId, title, repo: body.repo, jiraBaseUrl: process.env.JIRA_BASE_URL ?? '', task: body.task },
      {
        db,
        bus,
        adapter,
        createWorktree: (repo: string, id: string) => createWorktree(AGENTS_ROOT, repo, id),
        removeWorktree: (repo: string, path: string) => removeWorktree(AGENTS_ROOT, repo, path),
        now: () => new Date().toISOString(),
        genId: () => runId,
        onStart: (handle: AgentHandle) => {
          control.handle = handle;
          if (control.stopped) handle.stop();
        },
        jira,
        botAccountId: cfg.botAccountId ?? undefined,
        statusInProgress: cfg.statusInProgress,
        statusInReview: cfg.statusInReview,
        findPrNumber: (repo: string, branch: string) =>
          cfg.github ? findPrNumberByBranch(cfg.github, repo, branch) : Promise.resolve(null),
        maxAttempts: cfg.maxAttempts,
        maxCostUsd: cfg.maxCostUsd,
        isStopped: () => control.stopped,
      },
    ).finally(() => pm.remove(runId));
  })();
  return runId;
}

function fetchTopBacklog(repo: string): Promise<{ ticketId: string; title: string } | null> {
  const cfg: AppConfig = configStore.current();
  const project: string | undefined = cfg.repoProjectMap[repo];
  if (!project || !cfg.jira) return Promise.resolve(null);
  return fetchQueueIssues({ ...cfg.jira, project }).then(
    (issues: JiraIssue[]): { ticketId: string; title: string } | null =>
      issues[0] ? { ticketId: issues[0].key, title: issues[0].fields.summary } : null,
  );
}

const scheduler: AutoClaimScheduler = new AutoClaimScheduler({
  canStart: (r: string) => pm.canStart(r).ok,
  fetchTopBacklog,
  launch,
  onLog: (m: string) => process.stderr.write(m + '\n'),
});

setInterval(() => void scheduler.tick(), startupCfg.autoClaimIntervalMs);

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
      const off: () => void = bus.subscribe(logMatch[1], (ev: AgentEvent) => {
        res.write(`data: ${JSON.stringify({ ...ev, runId: logMatch[1] })}\n\n`);
        if (ev.kind === 'run-complete') {
          off();
          res.end();
        }
      });
      req.on('close', off);
      return;
    }
    const body: unknown = req.method === 'POST' ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      dashboard: (repo) => buildDashboardResponse(configStore.effectiveEnv(), new Date(), undefined, repo),
      db,
      canStart: (repo: string) => pm.canStart(repo),
      launch,
      stop: (id: string) => pm.stop(id),
      setAutoClaim: (repo: string, enabled: boolean) => scheduler.setEnabled(repo, enabled),
      autoClaimRepos: () => scheduler.enabledRepos(),
      caps: () => {
        const c: AppConfig = configStore.current();
        return { maxAttempts: c.maxAttempts, maxCostUsd: c.maxCostUsd };
      },
      getConfig: () => ({ config: publicConfig(configStore.current()), overridden: Object.keys(configStore.overrides()) }),
      setConfig: (key: string, value: string): { ok: true } | { ok: false; error: string } => {
        try {
          configStore.setOverride(key, value, () => new Date().toISOString());
          return { ok: true as const };
        } catch (err: unknown) {
          return { ok: false as const, error: err instanceof Error ? err.message : 'invalid config key' };
        }
      },
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

server.listen(PORT, '127.0.0.1', () => process.stdout.write(`orchestrator on :${PORT}\n`));
