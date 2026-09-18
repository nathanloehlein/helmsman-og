import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { buildTriageResponse } from '../triage-endpoint';
import { buildBugsResponse } from '../bugs-endpoint';
import type { AppConfig } from '../config';
import { openDb } from './db';
import { recoverRuns } from './recovery';
import { handleApi } from './router';
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { handleRunLog } from './run-log';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { hasCmux, pickHost, type RunHost } from './run-host';
import { claudeCodeAdapter } from './agents/claude-code';
import { commandAdapter } from './agents/command';
import { codexAdapter } from './agents/codex';
import { createWorktree, createWorktreeFromBranch, createReviewWorktree, discoverRepoDirs, listAgentWorktrees, removeWorktree, removeWorktreeAt, repoBasename, sweepOrphanedWorktrees } from './worktree';
import { makeJiraActions, type JiraActions } from './jira-actions';
import { findPrNumberByBranch, fetchPrStatus, fetchPrDiff, submitReview as ghSubmitReview, requestCopilotReview as ghRequestCopilotReview, type PrStatus } from '../github';
import { fetchRepoOpenPrs, fetchReviewRequestedPrs } from '../pr-lists';
import { getLocalGit, mutateLocalGit } from '../local-git';
import type { PrFileDiff } from '../../src/types';
import { AutoClaimScheduler } from './scheduler';
import { ConfigStore, publicConfig, WRITABLE_SECRET_KEYS } from './config-store';
import { fetchQueueIssues, fetchIssueSummary } from '../jira';
import { createBridge, type Bridge } from './cmux/bridge';
import { createWezTermBridge } from './wezterm/bridge';
import { openSlackStore } from './slack/store';
import { createSlackWatcher, type SlackWatcher } from './slack/watcher';
import { createSlackBrowserReader } from './slack/browser';
import { publicSlackSettings, slackSettings, SLACK_INTERVAL_MS } from './slack/config';
import type { SlackState } from '../../src/data/slack';
import { createGithubReviewWatcher } from './github-review-watcher';
import { fetchReviewHead, fetchReviewScope, selectReviewModel } from './review-policy';
import { publishInlineReview } from './inline-review';
import { createOutboundMeter } from './outbound-meter';
import { keysFor } from './cmux/actions';
import type { AgentAdapter, AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { JiraIssue } from '../types';

process.loadEnvFile('.env');
const outboundMeter = createOutboundMeter();

const PORT: number = Number(process.env.HELMSMAN_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const dbPath = process.env.HELMSMAN_DB ?? join(process.cwd(), '.helmsman.sqlite');
const db = openDb(dbPath);
const slackStore = openSlackStore(dbPath);
const pm: ProcessManager = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();
const RUNS_DIR: string = process.env.RUNS_DIR ?? join(AGENTS_ROOT, '.helmsman-runs');
mkdirSync(RUNS_DIR, { recursive: true });
const WRAPPER: string = fileURLToPath(new URL('./run-wrapper.mjs', import.meta.url));
const configStore: ConfigStore = new ConfigStore(process.env, db);
const startupCfg: AppConfig = configStore.current();
// cmux is macOS-only; wezterm is the cross-platform terminal driving the same
// panel. TERM_BRIDGE forces one, otherwise take whichever suits the platform.
const termBridge: string = process.env.TERM_BRIDGE ?? (process.platform === 'win32' ? 'wezterm' : 'cmux');
const cmux: Bridge = termBridge === 'wezterm' ? createWezTermBridge() : createBridge();
process.stdout.write(`terminal bridge: ${termBridge}\n`);
const cmuxClients = new Set<ServerResponse>();
let cmuxWatchOff: (() => void) | null = null;
function ensureCmuxWatch(): void {
  if (cmuxWatchOff) return;
  cmuxWatchOff = cmux.watchEvents(() => {
    for (const res of cmuxClients) res.write(`data: ${JSON.stringify({ kind: 'cmux-tabs-changed' })}\n\n`);
  });
}

const preferCmux: boolean = process.env.RUN_HOST === 'cmux';
const host: RunHost = await pickHost({ hasCmux, wrapperPath: WRAPPER, preferCmux });
process.stdout.write(`run host: ${host.kind}\n`);

function adapterFor(id: string, cfg: AppConfig): AgentAdapter {
  if (id === 'command') return commandAdapter(cfg.agentCmd ?? '');
  if (id === 'claude-code') return claudeCodeAdapter;
  return codexAdapter;
}

function baseRunnerDeps(cfg: AppConfig, jira: JiraActions | null): Omit<RunnerDeps, 'adapter' | 'genId' | 'onLaunch' | 'isStopped'> {
  return {
    db,
    bus,
    host,
    runsDir: RUNS_DIR,
    createWorktree: (repo: string, id: string) => createWorktree(AGENTS_ROOT, repo, id),
    createWorktreeFromBranch: (repo: string, id: string, branch: string) => createWorktreeFromBranch(AGENTS_ROOT, repo, id, branch),
    createReviewWorktree: (repo, id, number, headSha) => createReviewWorktree(AGENTS_ROOT, repo, id, number, headSha),
    removeWorktree: (repo: string, path: string) => removeWorktree(AGENTS_ROOT, repo, path),
    now: () => new Date().toISOString(),
    jira,
    botAccountId: cfg.botAccountId ?? undefined,
    statusInProgress: cfg.statusInProgress,
    statusInReview: cfg.statusInReview,
    findPrNumber: (repo: string, branch: string) =>
      cfg.github ? findPrNumberByBranch(cfg.github, repo, branch) : Promise.resolve(null),
    maxAttempts: cfg.maxAttempts,
    maxCostUsd: cfg.maxCostUsd,
    readReview: (worktreePath: string) =>
      readFile(join(worktreePath, '.agent-review.md'), 'utf8').catch((): null => null),
    readReviewComments: (worktreePath: string) =>
      readFile(join(worktreePath, '.agent-review-comments.json'), 'utf8').catch((error: unknown): null => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }),
    postReview: (repo, prNumber, reviewBody, input) => {
      const g: AppConfig['github'] = configStore.current().github;
      return g
        ? publishInlineReview(g, repo, prNumber, reviewBody, input ?? { comments: [] })
        : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
    },
    requestCopilotReview: (repo: string, prNumber: number) => {
      const g: AppConfig['github'] = configStore.current().github;
      return g
        ? ghRequestCopilotReview(g, repo, prNumber)
        : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
    },
  };
}

function dispatchReattach(row: RunRow): Promise<void> {
  const cfg: AppConfig = configStore.current();
  const jira: JiraActions | null = cfg.jira ? makeJiraActions(cfg.jira) : null;
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  pm.add(row.id, row.repo, () => {
    control.stopped = true;
    void control.stop?.();
  });
  const deps: RunnerDeps = {
    ...baseRunnerDeps(cfg, jira),
    adapter: adapterFor(row.adapter, cfg),
    genId: () => row.id,
    onLaunch: (_runId: string, stop: () => Promise<void>) => {
      control.stop = stop;
      if (control.stopped) void stop();
    },
    isStopped: () => control.stopped,
  };
  return reattachRun(row, deps).finally(() => pm.remove(row.id));
}

const reattachIds: string[] = db.reattachableRuns().map((r: RunRow) => r.id);

try {
  const repos: string[] = [...Object.keys(startupCfg.repoProjectMap), ...(startupCfg.github?.repo ? [startupCfg.github.repo] : [])];
  const configuredDirs: string[] = repos.map((repo: string) => join(AGENTS_ROOT, repoBasename(repo)));
  const discoveredDirs: string[] = await discoverRepoDirs(AGENTS_ROOT);
  const repoDirs: string[] = [...new Set([...configuredDirs, ...discoveredDirs])];
  if (repoDirs.length > 0) {
    const removed: string[] = await sweepOrphanedWorktrees({
      listAgentWorktrees,
      remove: removeWorktreeAt,
      isActiveRunId: (id: string) => pm.hasRun(id) || reattachIds.includes(id),
      repoDirs,
    });
    if (removed.length > 0) process.stdout.write(`swept ${removed.length} orphaned worktree(s)\n`);
  }
} catch (err: unknown) {
  process.stderr.write(`worktree sweep failed: ${String(err)}\n`);
}

void recoverRuns(db, { reattach: (row: RunRow) => dispatchReattach(row) })
  .then((result: { reattached: string[]; failed: string[] }) => {
    if (result.reattached.length > 0) process.stdout.write(`reattached ${result.reattached.length} run(s)\n`);
  })
  .catch((err: unknown) => process.stderr.write(`run recovery failed: ${String(err)}\n`));

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

function launch(body: { ticketId?: string; title?: string; repo: string; task?: string; prNumber?: number; mode?: string; feedback?: string; model?: string; effort?: string; runId?: string; headSha?: string }): string {
  const runId: string = body.runId ?? randomUUID();
  if (db.getRun(runId) || pm.hasRun(runId)) return runId;
  const cfg: AppConfig = configStore.current();
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  pm.add(runId, body.repo, () => {
    control.stopped = true;
    void control.stop?.();
  });
  const adapter: AgentAdapter =
    cfg.agentAdapter === 'command' && cfg.agentCmd
      ? commandAdapter(cfg.agentCmd)
      : cfg.agentAdapter === 'claude-code'
        ? claudeCodeAdapter
        : codexAdapter;
  if (cfg.agentAdapter === 'command' && !cfg.agentCmd) {
    process.stderr.write('AGENT_ADAPTER=command but AGENT_CMD is empty; using codex\n');
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
        const pr = cfg.github && body.prNumber ? await fetchReviewHead(cfg.github, body.repo, body.prNumber) : null;
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
        if (body.headSha && pr.headSha !== body.headSha) throw new Error('PR changed before review launch; the next poll will discover the new revision');
        const scope = cfg.github ? await fetchReviewScope(cfg.github, body.repo, pr.number) : null;
        if (body.headSha && scope?.headSha && scope.headSha !== body.headSha) throw new Error('PR changed during review preparation; the next poll will discover the new revision');
        const choice = selectReviewModel(scope?.headSha === pr.headSha ? scope : null, adapter.id, body);
        taskObj = {
          ticketId: 'review', title: `review #${pr.number}`, repo: body.repo,
          jiraBaseUrl: cfg.jira?.baseUrl ?? '',
          prBranch: pr.headRefName, prNumber: pr.number, review: true,
          model: choice.model, effort: choice.effort, reviewComplexity: choice.complexity,
          reviewReason: choice.reason, prHeadSha: scope?.headSha ?? pr.headSha,
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
      taskObj.model ??= body.model;
      taskObj.effort ??= body.effort;
      await startRun(taskObj, {
        ...baseRunnerDeps(cfg, jira),
        adapter,
        genId: () => runId,
        onLaunch: (_runId: string, stop: () => Promise<void>) => {
          control.stop = stop;
          if (control.stopped) void stop();
        },
        isStopped: () => control.stopped,
      });
    } catch (error: unknown) {
      const ts = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      if (db.getRun(runId)) db.updateRun(runId, { status: 'failed', endedAt: ts });
      else db.insertRun({
        id: runId, ticketId: body.mode ?? body.ticketId ?? 'freeform', repo: body.repo,
        adapter: adapter.id, status: 'failed', attempt: 1, prNumber: body.prNumber ?? null,
        startedAt: ts, endedAt: ts, costUsd: null, worktreePath: null,
      });
      db.appendEvent(runId, 'error', message, ts);
      db.appendEvent(runId, 'run-complete', 'failed', ts);
      bus.publish(runId, { kind: 'error', text: message });
      bus.publish(runId, { kind: 'run-complete', text: 'failed' });
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

let slackWatcher: SlackWatcher | null = null;
let slackSettingsKey = '';
let slackTick: Promise<void> | null = null;

function configuredSlackWatcher(): SlackWatcher | null {
  const settings = slackSettings(configStore.effectiveEnv());
  const key = JSON.stringify(settings);
  if (key === slackSettingsKey) return slackWatcher;
  slackSettingsKey = key;
  slackWatcher = settings.enabled && !settings.error ? createSlackWatcher({
    ...settings, store: slackStore, source: createSlackBrowserReader(settings),
    allowedRepos: () => {
      const cfg = configStore.current();
      return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
    },
    canLaunch: (repo) => JSON.stringify(slackSettings(configStore.effectiveEnv())) === key
      && Boolean(configStore.current().github) && pm.canStart(repo).ok,
    getRun: (id) => db.getRun(id), isRunActive: (id) => pm.hasRun(id), launch,
    intervalMs: SLACK_INTERVAL_MS,
  }) : null;
  return slackWatcher;
}

function slackSnapshot(): SlackState {
  const settings = slackSettings(configStore.effectiveEnv());
  const watcher = configuredSlackWatcher();
  return {
    health: watcher?.health() ?? {
      enabled: settings.enabled, status: settings.enabled ? 'unavailable' : 'disabled',
      channelName: settings.channelName, intervalMs: SLACK_INTERVAL_MS,
      lastSuccessAt: null, error: settings.error,
    },
    githubHealth: githubReviewWatcher.health(),
    notifications: slackStore.listNotifications().map((notification) => {
      const run = notification.runId ? db.getRun(notification.runId) : null;
      let task: Partial<AgentTask> | null = null;
      try {
        const parsed: unknown = run?.taskJson ? JSON.parse(run.taskJson) : null;
        if (parsed && typeof parsed === 'object') task = parsed as Partial<AgentTask>;
      } catch { task = null; }
      return { ...notification, runId: run?.id ?? null,
        model: task?.model ?? null, effort: task?.effort ?? null, complexity: task?.reviewComplexity ?? null };
    }),
  };
}

function pollSlack(): Promise<void> {
  slackTick ??= Promise.resolve().then(async () => {
    await configuredSlackWatcher()?.poll();
  }).catch((error: unknown) => process.stderr.write(`Slack watcher failed: ${String(error)}\n`))
    .then(() => undefined).finally(() => { slackTick = null; });
  return slackTick;
}

setInterval(() => void pollSlack(), SLACK_INTERVAL_MS);

const githubReviewEnabled = () => configStore.effectiveEnv().GITHUB_REVIEW_WATCH_ENABLED === 'true';
const githubReviewWatcher = createGithubReviewWatcher({
  store: slackStore,
  enabled: githubReviewEnabled,
  fetchRequested: () => {
    const cfg = configStore.current();
    return fetchReviewRequestedPrs(cfg.github);
  },
  fetchPr: (repo, number) => {
    const github = configStore.current().github;
    return github ? fetchReviewHead(github, repo, number) : Promise.resolve(null);
  },
  allowedRepos: () => {
    const cfg = configStore.current();
    return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
  },
  canLaunch: (repo) => githubReviewEnabled() && pm.canStart(repo).ok,
  getRun: (id) => db.getRun(id), isRunActive: (id) => pm.hasRun(id), launch,
  findExistingReview: (repo, number, headSha) => {
    for (const run of db.listRuns(1000)) {
      if (run.repo.toLowerCase() !== repo.toLowerCase() || run.prNumber !== number || !['running', 'succeeded'].includes(run.status)) continue;
      try {
        const task: unknown = run.taskJson ? JSON.parse(run.taskJson) : null;
        if (task && typeof task === 'object' && 'review' in task && task.review === true && 'prHeadSha' in task && task.prHeadSha === headSha) return run.id;
      } catch { continue; }
    }
    return null;
  },
  intervalMs: SLACK_INTERVAL_MS,
});

const pollGithubReviews = () => githubReviewWatcher.poll().catch((error: unknown) => process.stderr.write(`GitHub review watcher failed: ${String(error)}\n`));
setInterval(() => void pollGithubReviews(), SLACK_INTERVAL_MS);
void pollSlack();
void pollGithubReviews();

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
    if (await handleRunLog(req, res, url.pathname, db, bus)) return;
    if (url.pathname === '/api/cmux/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'connected' })}\n\n`);
      cmuxClients.add(res);
      ensureCmuxWatch();
      req.on('close', () => cmuxClients.delete(res));
      return;
    }
    const hasBody: boolean = req.method === 'POST' || req.method === 'PUT';
    const body: unknown = hasBody ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      outboundUsage: () => outboundMeter.snapshot(),
      context: () => {
        const cfg = configStore.current();
        return {
          repos: [...new Set([...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])])].sort(),
          jiraBaseUrl: cfg.jira?.baseUrl ?? null,
        };
      },
      slack: { snapshot: slackSnapshot, markRead: (id) => slackStore.markRead(id, new Date().toISOString()) },
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
      getConfig: () => ({
        config: { ...publicConfig(configStore.current()), ...publicSlackSettings(configStore.effectiveEnv()), GITHUB_REVIEW_WATCH_ENABLED: githubReviewEnabled() ? 'true' : 'false' },
        overridden: Object.keys(configStore.overrides()),
        jiraTokenSet: configStore.hasJiraToken(),
      }),
      setConfig: (key: string, value: string): { ok: true } | { ok: false; error: string } => {
        try {
          if (WRITABLE_SECRET_KEYS.includes(key)) configStore.setSecret(key, value, () => new Date().toISOString());
          else configStore.setOverride(key, value, () => new Date().toISOString());
          if (key.startsWith('SLACK_')) {
            configuredSlackWatcher();
            void pollSlack();
          }
          if (key === 'GITHUB_REVIEW_WATCH_ENABLED') void pollGithubReviews();
          return { ok: true as const };
        } catch (err: unknown) {
          return { ok: false as const, error: err instanceof Error ? err.message : 'invalid config key' };
        }
      },
      reviewRequestedPrs: (repo) => {
        const cfg: AppConfig = configStore.current();
        const repos: string[] = [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
        return fetchReviewRequestedPrs(cfg.github, repos, repo);
      },
      repoOpenPrs: (repo) => fetchRepoOpenPrs(configStore.current().github, repo),
      localGit: (repo) => {
        const cfg = configStore.current();
        const repos = [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
        return getLocalGit(AGENTS_ROOT, repo, repos, {
          activeWorktreePaths: () => db.activeRuns().flatMap(run => run.worktreePath ? [run.worktreePath] : []),
        });
      },
      localGitAction: (repo, body) => {
        const cfg = configStore.current();
        const repos = [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
        return mutateLocalGit(AGENTS_ROOT, repo, repos, body, {
          activeWorktreePaths: () => db.activeRuns().flatMap(run => run.worktreePath ? [run.worktreePath] : []),
        });
      },
      prStatus: (repo: string, prNumber: number): Promise<PrStatus | null> => {
        const g: AppConfig['github'] = configStore.current().github;
        return g ? fetchPrStatus(g, repo, prNumber) : Promise.resolve(null);
      },
      prDiff: (repo: string, prNumber: number): Promise<PrFileDiff[] | null> => {
        const g: AppConfig['github'] = configStore.current().github;
        return g ? fetchPrDiff(g, repo, prNumber) : Promise.resolve(null);
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
        const file: string = join(tmpdir(), `helmsman-clip-${randomUUID()}.${safeExt}`);
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
    const isPage = /^\/(?:helm|triage|cmux|bugs|prs?|runs|config)?\/?$/.test(url.pathname);
    const rel: string = isPage ? '/index.html' : url.pathname;
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

server.listen(PORT, '127.0.0.1', () => process.stdout.write(`Helmsman on :${PORT}\n`));
