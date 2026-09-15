import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { buildTriageResponse } from '../triage-endpoint';
import { buildBugsResponse } from '../bugs-endpoint';
import type { AppConfig } from '../config';
import { openDb } from './db';
import { recoverOrphanedRuns } from './recovery';
import { handleApi } from './router';
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { startRun } from './runner';
import { claudeCodeAdapter } from './agents/claude-code';
import { commandAdapter } from './agents/command';
import { codexAdapter } from './agents/codex';
import { createWorktree, createWorktreeFromBranch, discoverRepoDirs, listAgentWorktrees, removeWorktree, removeWorktreeAt, repoBasename, sweepOrphanedWorktrees } from './worktree';
import { makeJiraActions, type JiraActions } from './jira-actions';
import { findPrNumberByBranch, fetchPrStatus, submitReview as ghSubmitReview, requestCopilotReview as ghRequestCopilotReview, type PrStatus } from '../github';
import { AutoClaimScheduler } from './scheduler';
import { ConfigStore, publicConfig } from './config-store';
import { fetchQueueIssues, fetchIssueSummary } from '../jira';
import { createBridge } from './cmux/bridge';
import { keysFor } from './cmux/actions';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentTask } from './agents/adapter';
import type { RunEventRow, RunRow } from './db';
import type { JiraIssue } from '../types';

process.loadEnvFile('.env');

const PORT: number = Number(process.env.ORCHESTRATOR_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const db = openDb(process.env.ORCHESTRATOR_DB ?? join(process.cwd(), '.gomaestro.sqlite'));
const pm: ProcessManager = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();
const configStore: ConfigStore = new ConfigStore(process.env, db);
const startupCfg: AppConfig = configStore.current();
const cmux = createBridge();
const cmuxClients = new Set<ServerResponse>();
let cmuxWatchOff: (() => void) | null = null;
function ensureCmuxWatch(): void {
  if (cmuxWatchOff) return;
  cmuxWatchOff = cmux.watchEvents(() => {
    for (const res of cmuxClients) res.write(`data: ${JSON.stringify({ kind: 'cmux-tabs-changed' })}\n\n`);
  });
}

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

function launch(body: { ticketId?: string; title?: string; repo: string; task?: string; prNumber?: number; mode?: string; feedback?: string; model?: string; effort?: string }): string {
  const runId: string = randomUUID();
  const cfg: AppConfig = configStore.current();
  const control: { stopped: boolean; handle: AgentHandle | null } = { stopped: false, handle: null };
  pm.add(runId, body.repo, () => {
    control.stopped = true;
    control.handle?.stop();
  });
  const adapter: AgentAdapter =
    cfg.agentAdapter === 'command' && cfg.agentCmd
      ? commandAdapter(cfg.agentCmd)
      : cfg.agentAdapter === 'claude-code'
        ? claudeCodeAdapter
        : codexAdapter;
  if (cfg.agentAdapter === 'command' && !cfg.agentCmd) {
    process.stderr.write('AGENT_ADAPTER=command but AGENT_CMD is empty; using claude-code\n');
  }
  const jira: JiraActions | null = cfg.jira ? makeJiraActions(cfg.jira) : null;
  void (async (): Promise<void> => {
    try {
      let taskObj: AgentTask;
      if (body.mode === 'rerun') {
        const pr: PrStatus | null =
          cfg.github && body.prNumber ? await fetchPrStatus(cfg.github, body.repo, body.prNumber) : null;
        if (!pr) {
          const ts: string = new Date().toISOString();
          const failedRow: RunRow = {
            id: runId, ticketId: 'rerun', repo: body.repo, adapter: adapter.id,
            status: 'failed', attempt: 1, prNumber: body.prNumber ?? null, startedAt: ts,
            endedAt: ts, costUsd: null, worktreePath: null,
          };
          db.insertRun(failedRow);
          const message: string = `could not resolve PR #${body.prNumber ?? '?'} for rerun`;
          db.appendEvent(runId, 'error', message, ts);
          db.appendEvent(runId, 'run-complete', 'failed', ts);
          bus.publish(runId, { kind: 'error', text: message });
          bus.publish(runId, { kind: 'run-complete', text: 'failed' });
          return;
        }
        taskObj = {
          ticketId: 'rerun', title: `rerun #${pr.number}`, repo: body.repo,
          jiraBaseUrl: cfg.jira?.baseUrl ?? '', task: body.feedback ?? '',
          prBranch: pr.headRefName, prNumber: pr.number,
        };
      } else if (body.mode === 'review') {
        const pr: PrStatus | null =
          cfg.github && body.prNumber ? await fetchPrStatus(cfg.github, body.repo, body.prNumber) : null;
        if (!pr) {
          const ts: string = new Date().toISOString();
          const failedRow: RunRow = {
            id: runId, ticketId: 'review', repo: body.repo, adapter: adapter.id,
            status: 'failed', attempt: 1, prNumber: body.prNumber ?? null, startedAt: ts,
            endedAt: ts, costUsd: null, worktreePath: null,
          };
          db.insertRun(failedRow);
          const message: string = `could not resolve PR #${body.prNumber ?? '?'} for review`;
          db.appendEvent(runId, 'error', message, ts);
          db.appendEvent(runId, 'run-complete', 'failed', ts);
          bus.publish(runId, { kind: 'error', text: message });
          bus.publish(runId, { kind: 'run-complete', text: 'failed' });
          return;
        }
        taskObj = {
          ticketId: 'review', title: `review #${pr.number}`, repo: body.repo,
          jiraBaseUrl: cfg.jira?.baseUrl ?? '',
          prBranch: pr.headRefName, prNumber: pr.number, review: true,
        };
      } else {
        const ticketId: string = body.ticketId ?? 'freeform';
        const fetchedTitle: string | null =
          !body.title && body.ticketId && cfg.jira
            ? await fetchIssueSummary(cfg.jira, body.ticketId).catch((): null => null)
            : null;
        const title: string = body.title ?? fetchedTitle ?? ticketId;
        taskObj = { ticketId, title, repo: body.repo, jiraBaseUrl: cfg.jira?.baseUrl ?? '', task: body.task };
      }
      taskObj.model = body.model;
      taskObj.effort = body.effort;
      await startRun(taskObj, {
        db,
        bus,
        adapter,
        createWorktree: (repo: string, id: string) => createWorktree(AGENTS_ROOT, repo, id),
        createWorktreeFromBranch: (repo: string, id: string, branch: string) => createWorktreeFromBranch(AGENTS_ROOT, repo, id, branch),
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
        readReview: (worktreePath: string) =>
          readFile(join(worktreePath, '.agent-review.md'), 'utf8').catch((): null => null),
        postReview: (repo: string, prNumber: number, reviewBody: string) => {
          const g: AppConfig['github'] = configStore.current().github;
          return g
            ? ghSubmitReview(g, repo, prNumber, 'COMMENT', reviewBody)
            : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
        },
        requestCopilotReview: (repo: string, prNumber: number) => {
          const g: AppConfig['github'] = configStore.current().github;
          return g
            ? ghRequestCopilotReview(g, repo, prNumber)
            : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
        },
      });
    } finally {
      pm.remove(runId);
    }
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
    if (url.pathname === '/api/cmux/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'connected' })}\n\n`);
      cmuxClients.add(res);
      ensureCmuxWatch();
      req.on('close', () => cmuxClients.delete(res));
      return;
    }
    const body: unknown = req.method === 'POST' ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      dashboard: (repo) => buildDashboardResponse(configStore.effectiveEnv(), new Date(), undefined, repo),
      triage: (repo) => buildTriageResponse(configStore.effectiveEnv(), undefined, repo),
      bugs: (repo) => buildBugsResponse(configStore.effectiveEnv(), new Date(), undefined, repo),
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
      prStatus: (repo: string, prNumber: number): Promise<PrStatus | null> => {
        const g: AppConfig['github'] = configStore.current().github;
        return g ? fetchPrStatus(g, repo, prNumber) : Promise.resolve(null);
      },
      submitReview: (
        repo: string,
        prNumber: number,
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        body: string,
      ): Promise<{ ok: true } | { ok: false; error: string }> => {
        const g: AppConfig['github'] = configStore.current().github;
        return g ? ghSubmitReview(g, repo, prNumber, event, body) : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
      },
      cmuxListTabs: () => cmux.listTabs(),
      cmuxReadScreen: (surface: string, lines: number) => cmux.readScreen(surface, lines),
      cmuxSend: (surface: string, text: string, enter: boolean) => cmux.send(surface, text, enter),
      cmuxPasteImage: async (surface: string, dataBase64: string, ext: string) => {
        const safeExt: string = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'png';
        const file: string = join(tmpdir(), `gomaestro-clip-${randomUUID()}.${safeExt}`);
        try {
          await writeFile(file, Buffer.from(dataBase64, 'base64'));
        } catch (err: unknown) {
          return { ok: false as const, error: `write failed: ${String(err)}` };
        }
        const r = await cmux.send(surface, `${file} `, false);
        if (!r.ok) return r;
        return { ok: true as const, path: file };
      },
      cmuxAction: async (surface: string, provider: string | null, action: string) => {
        const keys = keysFor(provider, action as never);
        if (!keys) return { ok: false as const, error: 'unknown action' };
        for (const k of keys) {
          const r = await cmux.sendKey(surface, k);
          if (!r.ok) return r;
        }
        return { ok: true as const, keys };
      },
      cmuxKey: (surface: string, key: string) => cmux.sendKey(surface, key),
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
