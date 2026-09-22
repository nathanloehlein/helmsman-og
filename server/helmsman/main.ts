import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { buildTriageResponse } from '../triage-endpoint';
import { buildBugsResponse } from '../bugs-endpoint';
import { createFeedback } from './feedback';
import type { AppConfig } from '../config';
import { openDb } from './db';
import { openOutcomeStore } from './outcomes';
import { openRunTelemetry } from './run-telemetry';
import { prepareExecution } from './prepare-run';
import { GOCAAS_URL, goCaasKey, pinModelRouting, requiresGoCaas } from './gocaas';
import { openWebhookIntake, parseWebhookRoutes, WebhookError } from './webhooks';
import { openWorkflowStore } from './workflow-snapshots';
import { openCampaignStore } from './campaigns';
import { createCampaignDispatcher } from './campaign-dispatcher';
import { createCampaignService } from './campaign-service';
import { openClarificationStore } from './clarifications';
import { createScopedGateway } from './scoped-gateway';
import { createDockerWorkspace, removeDockerWorkspace } from './docker-workspace';
import { dockerHost, dockerRun, hasDocker } from './docker-host';
import { createClarificationRuntime, clarificationPaths } from './clarification-runtime';
import { createOutcomeService } from './outcome-service';
import { recoverRuns } from './recovery';
import { handleApi } from './router';
import { ProcessManager, RunConflictError } from './process-manager';
import { launchResources, restoredResources } from './run-reservations';
import { RunBus } from './event-bus';
import { handleRunLog } from './run-log';
import { startRun, reattachRun, type RunnerDeps } from './runner';
import { resumeFailedPrePrRun, ResumeError } from './resume';
import { hasCmux, hasWezTerm, pickHost, detachedHost, type HostRef, type RunHost } from './run-host';
import { claudeCodeAdapter } from './agents/claude-code';
import { commandAdapter } from './agents/command';
import { codexAdapter } from './agents/codex';
import { isPrePrAdapter, prePrAdapter } from './agents/pre-pr';
import { dockerReviewAdapter } from './agents/docker-review';
import { restoreRunAdapter } from './agents/restore';
import { readReviewArtifact } from './review-artifacts';
import { createWorktree, createWorktreeFromBranch, createReviewWorktree, discoverRepoDirs, listAgentWorktrees, removeWorktree, removeWorktreeAt, repoBasename, sweepOrphanedWorktrees } from './worktree';
import { makeLiveJiraActions, type JiraActions } from './jira-actions';
import { findPrNumberByBranch, fetchPrStatus, fetchPrDiff, submitReview as ghSubmitReview, requestCopilotReview as ghRequestCopilotReview, type PrStatus } from '../github';
import { fetchRepoOpenPrs, fetchReviewRequestedPrs } from '../pr-lists';
import { fetchGithubProfile } from '../github-profile';
import { getLocalGit, mutateLocalGit } from '../local-git';
import type { PrFileDiff } from '../../src/types';
import { openTodoStore, TodoConflictError } from './todos';
import { todoTask, reconcileTodoRuns } from './todo-source';
import { repositoryScope } from './repository-scope';
import { AutoClaimScheduler, type BacklogItem } from './scheduler';
import { ConfigStore, publicConfig, WRITABLE_SECRET_KEYS } from './config-store';
import { assignIssueToCurrentUser, fetchQueueIssues } from '../jira';
import { jiraTask } from './jira-task';
import { launchIntentJson, RetryError, type LaunchIntent } from './retry';
import { createBridge, type Bridge } from './cmux/bridge';
import { createWezTermBridge } from './wezterm/bridge';
import { openSlackStore } from './slack/store';
import { openVoyageNotifications } from './voyage-notifications';
import { createSlackWatcher, type SlackWatcher } from './slack/watcher';
import { fetchPrOwnership } from '../github-pr-ownership';
import { createSlackBrowserReader, runSlackBrowserCommand } from './slack/browser';
import { createFirefoxSlackBrowserTransport } from './slack/firefox-browser';
import { createFirefoxBridgeControl } from './slack/firefox-bridge';
import { createSlackBrowserReviewSender } from './slack/browser-review';
import { createSlackBrowserTransportSelector, publicSlackSettings, slackIntegrationEnabled, slackMcpTeamId, slackSettings, SLACK_INTERVAL_MS, SLACK_CONFIG_KEYS } from './slack/config';
import { openSlackOAuth } from './slack/oauth';
import { createSlackMcp } from './slack/mcp';
import { handleSlackConnection, trustedSlackOrigin } from './slack/oauth-http';
import { openSlackReviewRequester, publicSlackReviewSettings, slackReviewSettings, SlackReviewError } from './slack/review-request';
import type { SlackState } from '../../src/data/slack';
import { createGithubReviewWatcher } from './github-review-watcher';
import { createCreatedPrReviews } from './created-pr-reviews';
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
const todos = openTodoStore(dbPath);
reconcileTodoRuns(todos, db);
const slackStore = openSlackStore(dbPath);
const voyageNotifications = openVoyageNotifications(dbPath);
const pm: ProcessManager = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus: RunBus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();
const RUNS_DIR: string = process.env.RUNS_DIR ?? join(AGENTS_ROOT, '.helmsman-runs');
mkdirSync(RUNS_DIR, { recursive: true });
const WRAPPER: string = fileURLToPath(new URL('./run-wrapper.mjs', import.meta.url));
const configStore: ConfigStore = new ConfigStore(process.env, db);
let goCaasRequired = false;
function requireGoCaas(): boolean {
  goCaasRequired ||= requiresGoCaas(configStore.effectiveEnv(), existsSync(join(homedir(), '.gocode')));
  return goCaasRequired;
}
const outcomeStore = openOutcomeStore(dbPath);
const runTelemetry = openRunTelemetry(dbPath, outcomeStore);
const workflows = openWorkflowStore(dbPath);
const clarifications = openClarificationStore(dbPath, { getRun: id => db.getRun(id) });
const clarificationRuntime = createClarificationRuntime(clarifications, RUNS_DIR);
clarifications.cleanupOrphans();
const outcomes = createOutcomeService({ db, store: outcomeStore, fetchPr: (repo, number) => {
  const github = configStore.current().github;
  return github ? fetchPrStatus(github, repo, number) : Promise.resolve(null);
} });
const firefoxBridge = createFirefoxBridgeControl(() => configStore.effectiveEnv().SLACK_FIREFOX_WEBDRIVER_URL?.trim() || 'http://127.0.0.1:4444', {
  started: () => { slackBrowserTransport.reset(); slackSettingsKey = ''; },
});
const slackBrowserTransport = createSlackBrowserTransportSelector(createFirefoxSlackBrowserTransport, runSlackBrowserCommand);
const slackOAuth = openSlackOAuth({ path: join(RUNS_DIR, '.slack-auth', 'oauth.sqlite'), settings: () => {
  const env = configStore.effectiveEnv();
  return { clientId: env.SLACK_OAUTH_CLIENT_ID?.trim() ?? '', clientSecret: env.SLACK_OAUTH_CLIENT_SECRET?.trim() ?? '',
    redirectUri: env.SLACK_OAUTH_REDIRECT_URI?.trim() ?? '', teamId: slackMcpTeamId(env) };
} });
const slackMcp = createSlackMcp({ accessToken: () => slackOAuth.accessToken(),
  teamId: () => slackMcpTeamId(configStore.effectiveEnv()),
  channelId: () => configStore.effectiveEnv().SLACK_CHANNEL_ID?.trim() ?? '',
  channelName: () => configStore.effectiveEnv().SLACK_CHANNEL_NAME?.trim() ?? '',
  mentionGroupId: () => configStore.effectiveEnv().SLACK_REVIEW_GROUP_ID?.trim() ?? '',
  connectionVersion: () => slackWatcherKey(),
  canSend: () => slackSettings(configStore.effectiveEnv()).transport === 'mcp' && slackIntegrationEnabled(configStore.effectiveEnv()),
});
const slackReviewRequester = openSlackReviewRequester(dbPath, {
  settings: () => slackReviewSettings(configStore.effectiveEnv()),
  send: input => {
    const settings = slackSettings(configStore.effectiveEnv());
    if (settings.error) throw new SlackReviewError(settings.error, 400);
    if (settings.transport === 'mcp') return slackMcp.send(input);
    return createSlackBrowserReviewSender(settings, slackBrowserTransport(settings)).send(input);
  },
  getPr: (repo, prNumber) => {
    const github = configStore.current().github;
    return github ? fetchPrStatus(github, repo, prNumber) : Promise.resolve(null);
  },
});
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

// RUN_HOST opts a run into a visible terminal instead of a detached process.
const RUN_HOSTS: ReadonlyArray<HostRef['kind']> = ['cmux', 'wezterm', 'detached', 'docker'];
const runHost = RUN_HOSTS.find((k) => k === process.env.RUN_HOST) ?? null;
const DOCKER_WORKSPACES = join(AGENTS_ROOT, '.helmsman-docker-workspaces');
const gatewayPort = Number(process.env.HELMSMAN_GATEWAY_PORT ?? '8790');
const gatewayUrl = `http://host.docker.internal:${gatewayPort}`;
const gateway = createScopedGateway({ path: dbPath, openaiKey: () => process.env.OPENAI_API_KEY,
  anthropicKey: () => process.env.ANTHROPIC_API_KEY, githubKey: () => configStore.current().github?.token,
  modelUpstream: async (provider, runId) => {
    const row = db.getRun(runId);
    const task: AgentTask | null = row?.taskJson ? JSON.parse(row.taskJson) : null;
    if (requireGoCaas() || task?.modelRouting === 'gocaas') {
      return { baseUrl: provider === 'codex' ? `${GOCAAS_URL}/v1` : GOCAAS_URL, key: await goCaasKey() };
    }
    return provider === 'codex'
      ? { baseUrl: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY ?? '' }
      : { baseUrl: 'https://api.anthropic.com', key: process.env.ANTHROPIC_API_KEY ?? '' };
  },
  active: runId => db.getRun(runId)?.status === 'running',
  scope: runId => {
    const run = db.getRun(runId);
    if (!run) return null;
    const task = run.taskJson ? JSON.parse(run.taskJson) as AgentTask : null;
    return { repo: run.repo, branch: task?.prBranch ?? `agent/${runId}`, readOnly: Boolean(task?.review) };
  },
  clarificationReady: runId => { clarificationRuntime.poll(runId); return !clarificationRuntime.hasUnanswered(runId); },
});
if (runHost === 'docker') {
  if (!process.env.HELMSMAN_DOCKER_IMAGE) throw new Error('Set HELMSMAN_DOCKER_IMAGE to a built Helmsman runtime image before selecting Docker');
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) throw new Error('Invalid scoped gateway port');
  const gatewayServer = gateway.server();
  await new Promise<void>((resolve, reject) => { gatewayServer.once('error', reject); gatewayServer.listen(gatewayPort, '0.0.0.0', resolve); });
}
const selectedHost = await pickHost({ hasCmux, hasWezTerm, hasDocker, wrapperPath: WRAPPER, prefer: runHost,
  dockerHost: () => dockerHost({ image: process.env.HELMSMAN_DOCKER_IMAGE ?? '', runtimeRoot: RUNS_DIR, wrapperPath: WRAPPER, run: dockerRun, enabled: true }) });
const localHost = detachedHost(WRAPPER);
const host: RunHost = selectedHost.kind === 'docker' ? {
  kind: 'docker',
  launch: spec => spec.args.some(arg => arg.endsWith('/pre-pr-cli.ts') || arg.endsWith('/docker-review-cli.ts')) ? localHost.launch(spec) : selectedHost.launch(spec),
  isAlive: ref => ref.kind === 'detached' ? localHost.isAlive(ref) : selectedHost.isAlive(ref),
  stop: async ref => {
    await (ref.kind === 'detached' ? localHost.stop(ref) : selectedHost.stop(ref));
    const run = db.activeRuns().find(row => row.hostRef === JSON.stringify(ref));
    if (run) await stopDockerStages(run.id);
  },
} : selectedHost;
async function stopDockerStages(runId: string): Promise<void> {
  if (!/^[a-z\d_-]{1,128}$/i.test(runId)) return;
  try {
    const result = await dockerRun(['docker', 'ps', '-aq', '--filter', `label=helmsman.runId=${runId}`]);
    const ids = result.stdout.trim().split(/\s+/).filter(id => /^[a-f\d]{12,64}$/.test(id));
    if (ids.length) await dockerRun(['docker', 'rm', '-f', ...ids]);
    const networks = await dockerRun(['docker', 'network', 'ls', '-q', '--filter', `label=helmsman.runId=${runId}`]);
    const networkIds = networks.stdout.trim().split(/\s+/).filter(id => /^[a-f\d]{12,64}$/.test(id));
    if (networkIds.length) await dockerRun(['docker', 'network', 'rm', ...networkIds]);
  } catch (error) { process.stderr.write(`Docker stage cleanup failed: ${String(error)}\n`); }
}
async function standaloneWorkspace(repo: string, runId: string, mode: 'fresh' | 'review' | 'branch',
  create: () => Promise<{ path: string; branch: string }>, headSha?: string): Promise<{ path: string; branch: string }> {
  const source = await create();
  if (host.kind !== 'docker') return source;
  try {
    return await createDockerWorkspace({ source: source.path, root: DOCKER_WORKSPACES, runId, mode,
      branch: source.branch, ...(headSha ? { headSha } : {}) });
  } finally { await removeWorktree(AGENTS_ROOT, repo, source.path); }
}

process.stdout.write(`run host: ${host.kind}\n`);
if (host.kind === 'docker') {
  for (const row of db.listRuns(1000)) {
    if (row.status !== 'running' && row.taskJson?.includes('dockerExecution')) void stopDockerStages(row.id);
  }
}

function baseRunnerDeps(cfg: AppConfig, jira: JiraActions | null): Omit<RunnerDeps, 'adapter' | 'genId' | 'onLaunch' | 'isStopped'> {
  return {
    db,
    bus,
    host,
    runsDir: RUNS_DIR,
    recordAgentEvent: runTelemetry.record,
    pollClarifications: clarificationRuntime.poll,
    hasRequiredUnanswered: clarificationRuntime.hasUnanswered,
    onRunComplete: run => { runTelemetry.complete(run); clarificationRuntime.complete(run.id); gateway.revokeRun(run.id); if (host.kind === 'docker') void stopDockerStages(run.id); },
    createWorktree: (repo: string, id: string) => standaloneWorkspace(repo, id, 'fresh', () => createWorktree(AGENTS_ROOT, repo, id)),
    createWorktreeFromBranch: (repo: string, id: string, branch: string) => standaloneWorkspace(repo, id, 'branch', () => createWorktreeFromBranch(AGENTS_ROOT, repo, id, branch,
      path => pm.hasRun(basename(path)) || db.activeRuns().some(run => run.worktreePath === path))),
    createReviewWorktree: (repo, id, number, headSha) => standaloneWorkspace(repo, id, 'review', () => createReviewWorktree(AGENTS_ROOT, repo, id, number, headSha), headSha),
    removeWorktree: (repo: string, path: string) => path.startsWith(`${DOCKER_WORKSPACES}/`) ? removeDockerWorkspace(DOCKER_WORKSPACES, path) : removeWorktree(AGENTS_ROOT, repo, path),
    now: () => new Date().toISOString(),
    jira,
    botAccountId: cfg.botAccountId ?? undefined,
    statusInProgress: cfg.statusInProgress,
    statusInReview: cfg.statusInReview,
    findPrNumber: (repo: string, branch: string) =>
      cfg.github ? findPrNumberByBranch(cfg.github, repo, branch) : Promise.resolve(null),
    maxAttempts: cfg.maxAttempts,
    maxCostUsd: cfg.maxCostUsd,
    readReview: worktreePath => readReviewArtifact(worktreePath, '.agent-review.md'),
    readReviewComments: worktreePath => readReviewArtifact(worktreePath, '.agent-review-comments.json'),
    postReview: (repo, prNumber, reviewBody, input) => {
      const g: AppConfig['github'] = configStore.current().github;
      return g
        ? publishInlineReview(g, repo, prNumber, reviewBody, input)
        : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
    },
    requestCopilotReview: (repo: string, prNumber: number) => {
      if (requireGoCaas()) return Promise.resolve({ ok: false as const, error: 'Copilot reviews cannot route through GoCaaS; using Helmsman reviewers.' });
      const g: AppConfig['github'] = configStore.current().github;
      return g
        ? ghRequestCopilotReview(g, repo, prNumber)
        : Promise.resolve({ ok: false as const, error: 'GitHub not configured' });
    },
    enqueueCreatedPrReview: (input) => { createdPrReviews.enqueue(input); },
  };
}

function findExistingReview(repo: string, number: number, headSha: string): string | null {
  for (const run of db.listRuns(1000)) {
    if (run.repo.toLowerCase() !== repo.toLowerCase() || run.prNumber !== number || !['running', 'succeeded'].includes(run.status)) continue;
    try {
      const task: unknown = run.taskJson ? JSON.parse(run.taskJson) : null;
      if (task && typeof task === 'object' && 'review' in task && task.review === true && 'prHeadSha' in task && task.prHeadSha === headSha) return run.id;
    } catch { continue; }
  }
  return null;
}

const createdPrReviews = createCreatedPrReviews({
  store: slackStore,
  getRun: (id) => db.getRun(id),
  isRunActive: (id) => pm.hasRun(id),
  canLaunch: (repo) => Boolean(configStore.current().github) && pm.canStart(repo).ok,
  fetchPr: (repo, number) => {
    const github = configStore.current().github;
    return github ? fetchReviewHead(github, repo, number) : Promise.resolve(null);
  },
  findExistingReview,
  launch,
});

function pollCreatedPrReviews(): Promise<void> {
  return createdPrReviews.poll().catch((error: unknown) => { process.stderr.write(`Created PR review queue failed: ${String(error)}\n`); });
}

function dispatchReattach(row: RunRow, control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null }): Promise<void> {
  const cfg: AppConfig = configStore.current();
  const jira: JiraActions | null = cfg.jira ? makeLiveJiraActions(() => configStore.current().jira) : null;
  const adapter = restoreRunAdapter(row, { runsDir: RUNS_DIR, agentCmd: cfg.agentCmd });
  pm.restore(row.id, row.repo, () => {
    control.stopped = true;
    void control.stop?.();
  }, restoredResources(row));
  const deps: RunnerDeps = {
    ...baseRunnerDeps(cfg, jira),
    adapter,
    preserveWorktreeOnFailure: isPrePrAdapter(row.adapter),
    genId: () => row.id,
    onLaunch: (_runId: string, stop: () => Promise<void>) => {
      control.stop = stop;
      if (control.stopped) void stop();
    },
    isStopped: () => control.stopped,
  };
  return reattachRun(row, deps).finally(() => {
    const status = db.getRun(row.id)?.status;
    if (status && status !== 'running') todos.finishRun(row.id, status);
    pm.remove(row.id);
    void pollCreatedPrReviews();
  });
}

async function resumeVoyage(runId: string): Promise<void> {
  const row = db.getRun(runId);
  if (!row) throw new ResumeError('Voyage not found.');
  const cfg = configStore.current();
  const repos = repositoryScope(cfg, todos.list());
  if (!repos.some(repo => repo.toLowerCase() === row.repo.toLowerCase())) throw new ResumeError('Configure this galleon before continuing the voyage.');
  const gate = pm.canStart(row.repo, restoredResources(row));
  if (!gate.ok) throw new ResumeError(gate.reason ?? 'Cannot continue this voyage while another voyage is active.');
  if (cfg.maxCostUsd !== null && (row.costUsd ?? 0) >= cfg.maxCostUsd) throw new ResumeError('The voyage has reached its cost cap. Update the cap before continuing.');
  const task = row.taskJson ? JSON.parse(row.taskJson) as Partial<AgentTask> | null : null;
  if (!task?.task && !task?.todoId && !cfg.jira) throw new ResumeError('Configure Jira before continuing this Jira voyage.');
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  if (pm.hasRun(row.id)) throw new ResumeError('This voyage is already active.');
  pm.reserve(row.id, row.repo, () => { control.stopped = true; void control.stop?.(); }, restoredResources(row));
  try {
    const resumed = await resumeFailedPrePrRun(row, { db, host: host.kind === 'docker' && row.hostKind === 'detached' ? { ...host, kind: 'detached' } : host,
      runsDir: RUNS_DIR, now: () => new Date().toISOString(), isStopped: () => control.stopped,
      prepareTask: async task => {
        task = pinModelRouting(task, requireGoCaas());
        if (task.modelRouting === 'gocaas') await goCaasKey();
        const prepared = await prepareExecution({ runId, runsDir: RUNS_DIR, workflowDbPath: dbPath, task, provider: row.adapter === 'pre-pr:codex' ? 'codex' : 'claude-code', workflow: 'coding', reviewSettings: cfg.prePr, model: task.model, effort: task.effort });
        if (prepared.task.dockerExecution) {
          if (host.kind !== 'docker') throw new ResumeError('Select the Docker host before continuing an isolated voyage.');
          prepared.task.dockerExecution = { ...prepared.task.dockerExecution, capability: gateway.issue(runId, 86_400_000).token };
        }
        return prepared.task;
      } });
    void dispatchReattach(resumed, control).catch(error => { process.stderr.write(`Voyage continuation failed: ${String(error)}\n`); });
  } catch (error) {
    pm.remove(row.id);
    throw error;
  }
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
      isActiveRunId: (id: string) => {
        if (pm.hasRun(id) || reattachIds.includes(id)) return true;
        const row = db.getRun(id);
        return Boolean(row && isPrePrAdapter(row.adapter) && row.status !== 'succeeded');
      },
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

function launch(body: LaunchIntent & { runId?: string; headSha?: string; retryOf?: string; workflowRef?: string }): string {
  if (body.workflowRef) {
    const expected = body.mode === 'review' ? 'review@1' : 'coding@1';
    if (body.workflowRef !== expected) throw new Error('Workflow is unavailable or does not match the task mode');
  }
  const runId: string = body.runId ?? randomUUID();
  if (db.getRun(runId) || pm.hasRun(runId)) return runId;
  const cfg: AppConfig = configStore.current();
  const priorRun = body.retryOf ? db.getRun(body.retryOf) : null;
  const adapterId = priorRun?.adapter.replace(/^pre-pr:/, '') ?? body.adapter ?? cfg.agentAdapter;
  const priorTask = priorRun?.taskJson ? JSON.parse(priorRun.taskJson) as AgentTask | null : null;
  if ((requireGoCaas() || priorTask?.modelRouting === 'gocaas') && adapterId === 'command') {
    throw new Error('Custom command agents cannot enforce GoCaaS routing. Select Codex or Claude Code.');
  }
  const capacity = pm.canStart(body.repo, launchResources(runId, body, priorTask));
  if (!capacity.ok) throw new RunConflictError(capacity.reason);
  if (priorTask && Boolean(priorTask.dockerExecution) !== (host.kind === 'docker')) throw new RetryError('Retry requires the original local or Docker execution mode.');
  if (body.retryOf && adapterId === 'command' && !cfg.agentCmd) throw new RetryError('The original command agent is no longer configured. Configure it before retrying.');
  let localTodo = body.mode === 'todo' && body.todoId ? todos.get(body.todoId) : null;
  if (body.mode === 'todo') {
    if (cfg.jiraEnabled) throw new TodoConflictError('Disable Jira before launching todos.');
    if (!localTodo) throw new TodoConflictError('Todo not found.');
    const gate = pm.canStart(localTodo.repo, { ticketId: localTodo.id, branch: `agent/${runId}` });
    if (!gate.ok) throw new TodoConflictError(gate.reason ?? 'Cannot start voyage.');
    localTodo = todos.claim(localTodo.id, runId, body.retryOf);
    if (!localTodo) throw new TodoConflictError('Todo is no longer ready to launch.');
    body = { ...body, repo: localTodo.repo, ticketId: localTodo.id, title: localTodo.title };
  } else if (body.ticketId && todos.get(body.ticketId) && !body.task && (!body.mode || body.mode === 'ticket')) {
    throw new TodoConflictError('Local todos must be launched from Todos with Jira disabled.');
  } else if (!cfg.jiraEnabled && body.ticketId && !body.task && (!body.mode || body.mode === 'ticket')) {
    throw new TodoConflictError('Jira is disabled. Start a voyage from Todos.');
  }
  const launchJson = launchIntentJson(body);
  const control: { stopped: boolean; stop: (() => Promise<void>) | null } = { stopped: false, stop: null };
  pm.reserve(runId, body.repo, () => {
    control.stopped = true;
    void control.stop?.();
  }, launchResources(runId, body, priorTask));
  const adapter: AgentAdapter =
    adapterId === 'command' && cfg.agentCmd
      ? commandAdapter(cfg.agentCmd)
      : adapterId === 'claude-code'
        ? claudeCodeAdapter
        : codexAdapter;
  if (adapterId === 'command' && !cfg.agentCmd) {
    process.stderr.write('AGENT_ADAPTER=command but AGENT_CMD is empty; using codex\n');
  }
  const jira: JiraActions | null = cfg.jira ? makeLiveJiraActions(() => configStore.current().jira) : null;
  void (async (): Promise<void> => {
    try {
      let taskObj: AgentTask;
      if (priorTask) {
        if (priorTask.repo.toLowerCase() !== body.repo.toLowerCase()) throw new RetryError('Saved task belongs to another galleon.');
        taskObj = { ...priorTask, prePrResume: undefined };
      } else if (localTodo) {
        taskObj = todoTask(localTodo);
      } else if (body.mode === 'rerun') {
        const pr: PrStatus | null =
          cfg.github && body.prNumber ? await fetchPrStatus(cfg.github, body.repo, body.prNumber) : null;
        if (!pr) {
          const ts: string = new Date().toISOString();
          const failedRow: RunRow = {
            id: runId, ticketId: 'rerun', repo: body.repo, adapter: adapter.id,
            status: 'failed', attempt: 1, prNumber: body.prNumber ?? null, startedAt: ts,
            endedAt: ts, costUsd: null, worktreePath: null, launchJson,
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
            endedAt: ts, costUsd: null, worktreePath: null, launchJson,
          };
          db.insertRun(failedRow);
          const message: string = `could not resolve PR #${body.prNumber ?? '?'} for review`;
          db.appendEvent(runId, 'error', message, ts);
          db.appendEvent(runId, 'run-complete', 'failed', ts);
          bus.publish(runId, { kind: 'error', text: message });
          bus.publish(runId, { kind: 'run-complete', text: 'failed' });
          return;
        }
        if (body.headSha && pr.headSha !== body.headSha) throw new Error('PR changed before review launch; a new review is needed for the latest revision');
        const scope = cfg.github ? await fetchReviewScope(cfg.github, body.repo, pr.number) : null;
        if (body.headSha && scope?.headSha && scope.headSha !== body.headSha) throw new Error('PR changed during review preparation; a new review is needed for the latest revision');
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
        taskObj = body.ticketId && !body.task
          ? await jiraTask(cfg.jira, { ticketId, title: body.title, repo: body.repo })
          : { ticketId, title: body.title ?? ticketId, repo: body.repo, jiraBaseUrl: cfg.jira?.baseUrl ?? '', task: body.task };
      }
      taskObj = pinModelRouting(taskObj, requireGoCaas());
      if (taskObj.modelRouting === 'gocaas') await goCaasKey();
      pm.updateResources(runId, launchResources(runId, body, taskObj));
      taskObj.model ??= body.model;
      taskObj.effort ??= body.effort;
      if (body.retryOf) {
        const previous = db.getRun(body.retryOf);
        const priorTask = previous?.taskJson ? JSON.parse(previous.taskJson) as Partial<AgentTask> | null : null;
        if (priorTask?.workflowSnapshotId) taskObj.workflowSnapshotId = priorTask.workflowSnapshotId;
      }
      if (host.kind === 'docker') {
        if (taskObj.prBranch && !taskObj.review) throw new Error('Docker branch reruns require host publication support; use the trusted local run host for this mode.');
        if (taskObj.modelRouting !== 'gocaas') {
          if (adapter.id === 'codex' && !process.env.OPENAI_API_KEY || adapter.id === 'claude-code' && !process.env.ANTHROPIC_API_KEY) throw new Error('Configure the writer provider API key on the host before Docker execution.');
          if (!taskObj.review && cfg.prePr.reviewerCount > 1 && (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)) throw new Error('Docker dual review requires both provider API keys on the host.');
        }
        const image = priorTask?.dockerExecution?.image ?? (await dockerRun(['docker', 'image', 'inspect', '--format', '{{.Id}}', process.env.HELMSMAN_DOCKER_IMAGE!])).stdout.trim();
        if (!/^sha256:[a-f\d]{64}$/.test(image)) throw new Error('Docker image identity could not be pinned');
        const capability = gateway.issue(runId, 86_400_000);
        taskObj.dockerExecution = { image, gatewayUrl, capability: capability.token, runId };
      }
      taskObj.clarification = { ...clarificationPaths(RUNS_DIR, runId), gateUrl: `http://127.0.0.1:${PORT}/api/runs/${runId}/clarification-gate` };
      const prepared = await prepareExecution({ runId, runsDir: RUNS_DIR, workflowDbPath: dbPath, task: taskObj,
        provider: adapter.id === 'codex' ? 'codex' : adapter.id === 'claude-code' ? 'claude-code' : undefined, workflow: taskObj.review ? 'review' : 'coding', reviewSettings: cfg.prePr, model: taskObj.model, effort: taskObj.effort,
        skills: adapter.id === 'codex' && taskObj.review || !taskObj.review && !taskObj.prBranch && (adapter.id === 'codex' || cfg.prePr.reviewerCount > 1) ? ['review-agent'] : [] });
      taskObj = prepared.task;
      const runAdapter = !taskObj.review && !taskObj.prBranch ? prePrAdapter(adapter, RUNS_DIR, prepared.reviewSettings) : taskObj.review && taskObj.dockerExecution ? dockerReviewAdapter(adapter) : adapter;
      await startRun(taskObj, {
        ...baseRunnerDeps(cfg, jira),
        launchJson,
        adapter: runAdapter,
        ...(isPrePrAdapter(runAdapter.id) ? { maxAttempts: 1, preserveWorktreeOnFailure: true } : {}),
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
        id: runId, ticketId: body.ticketId ?? body.mode ?? 'freeform', repo: body.repo,
        adapter: adapter.id, status: 'failed', attempt: 1, prNumber: body.prNumber ?? null,
        startedAt: ts, endedAt: ts, costUsd: null, worktreePath: null, launchJson,
      });
      db.appendEvent(runId, 'error', message, ts);
      db.appendEvent(runId, 'run-complete', 'failed', ts);
      bus.publish(runId, { kind: 'error', text: message });
      bus.publish(runId, { kind: 'run-complete', text: 'failed' });
    } finally {
      const finalRun = db.getRun(runId);
      if (finalRun?.status === 'failed' && !finalRun.taskJson && !outcomeStore.getAssessment(runId)) {
        outcomeStore.saveAssessment({ runId, state: 'not-assessed', outcome: 'unknown', summary: 'Launch preflight failed before execution.', evidence: [], failureStage: 'preflight', correctionRounds: null });
      }
      if (finalRun?.status !== 'running') gateway.revokeRun(runId);
      const status = finalRun?.status;
      if (status && status !== 'running') todos.finishRun(runId, status);
      else if (localTodo) todos.finishRun(runId, 'failed');
      pm.remove(runId);
      void pollCreatedPrReviews();
    }
  })();
  return runId;
}

function fetchTopBacklog(repo: string): Promise<BacklogItem | null> {
  const cfg: AppConfig = configStore.current();
  if (!cfg.jiraEnabled) {
    const todo = todos.list().find(item => item.repo === repo && item.state === 'todo' && item.description.trim());
    return Promise.resolve(todo ? { ticketId: todo.id, title: todo.title, todoId: todo.id, mode: 'todo' } : null);
  }
  const project: string | undefined = cfg.repoProjectMap[repo];
  if (!project || !cfg.jira) return Promise.resolve(null);
  return fetchQueueIssues({ ...cfg.jira, project }).then(
    (issues: JiraIssue[]): { ticketId: string; title: string } | null => {
      const issue = issues.find(item => item?.key && item.fields?.summary && pm.canStart(repo, { ticketId: item.key }).ok);
      return issue?.key && issue.fields?.summary ? { ticketId: issue.key, title: issue.fields.summary } : null;
    },
  );
}

const scheduler: AutoClaimScheduler = new AutoClaimScheduler({
  canStart: (repo, item) => pm.canStart(repo, item ? { ticketId: item.ticketId } : {}).ok,
  fetchTopBacklog,
  launch,
  onLog: (m: string) => process.stderr.write(m + '\n'),
});

setInterval(() => void scheduler.tick(), startupCfg.autoClaimIntervalMs);

let slackWatcher: SlackWatcher | null = null;
let slackSettingsKey = '';
let slackTick: Promise<void> | null = null;
let slackConnectionGeneration = 0;

function slackWatcherKey(): string {
  return JSON.stringify([slackSettings(configStore.effectiveEnv()), slackConnectionGeneration]);
}

function configuredSlackWatcher(): SlackWatcher | null {
  const settings = slackSettings(configStore.effectiveEnv());
  const key = slackWatcherKey();
  if (key === slackSettingsKey) return slackWatcher;
  slackSettingsKey = key;
  slackWatcher = settings.enabled && !settings.error ? createSlackWatcher({
    ...settings, store: slackStore, source: settings.transport === 'mcp' ? slackMcp : createSlackBrowserReader(settings, slackBrowserTransport(settings)),
    allowedRepos: () => {
      const cfg = configStore.current();
      return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])];
    },
    canLaunch: (repo) => slackWatcherKey() === key
      && (settings.transport !== 'mcp' || slackOAuth.isConnected())
      && Boolean(configStore.current().github) && pm.canStart(repo).ok,
    isOwnPr: async (repo, prNumber) => {
      const github = configStore.current().github;
      const ownership = await fetchPrOwnership(github, repo, prNumber);
      const current = configStore.current().github;
      return current?.token === github?.token && current?.author === github?.author ? ownership : null;
    },
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
    notifications: [...slackStore.listNotifications().map((notification) => {
      const run = notification.runId ? db.getRun(notification.runId) : null;
      let task: Partial<AgentTask> | null = null;
      try {
        const parsed: unknown = run?.taskJson ? JSON.parse(run.taskJson) : null;
        if (parsed && typeof parsed === 'object') task = parsed as Partial<AgentTask>;
      } catch { task = null; }
      return { ...notification, runId: run?.id ?? null,
        model: task?.model ?? null, effort: task?.effort ?? null, complexity: task?.reviewComplexity ?? null };
    }), ...voyageNotifications.listNotifications()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || b.id.localeCompare(a.id)),
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
  findExistingReview,
  intervalMs: SLACK_INTERVAL_MS,
});

const pollGithubReviews = () => githubReviewWatcher.poll().catch((error: unknown) => process.stderr.write(`GitHub review watcher failed: ${String(error)}\n`));
setInterval(() => {
  void pollCreatedPrReviews();
  void pollGithubReviews();
}, SLACK_INTERVAL_MS);
void pollCreatedPrReviews();
void pollSlack();
void pollGithubReviews();

const campaignsStore = openCampaignStore(dbPath);
const configuredRepos = () => { const cfg = configStore.current(); return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])]; };
const campaignDispatcher = createCampaignDispatcher({ store: campaignsStore,
  canStart: (repo, record) => pm.canStart(repo, record?.ticketId ? { ticketId: record.ticketId } : {}).ok,
  isRunActive: id => pm.hasRun(id),
  getRun: id => db.getRun(id), stop: id => pm.stop(id),
  launch: input => launch({ repo: input.repo, mode: input.mode, runId: input.runId, workflowRef: input.workflowRef,
    ...(input.task === null ? {} : { task: input.task }), ...(input.ticketId === null ? {} : { ticketId: input.ticketId }),
    ...(input.title === null ? {} : { title: input.title }), ...(input.retryOf ? { retryOf: input.retryOf } : {}) }),
});
const campaigns = createCampaignService({ store: campaignsStore, configuredRepos,
  workflows: () => [{ ref: 'coding@1', name: 'Coding' }], dispatch: () => campaignDispatcher.poll() });
setInterval(() => { void campaignDispatcher.poll().catch(error => process.stderr.write(`Campaign dispatch failed: ${String(error)}\n`)); }, 5000);

const webhooks = openWebhookIntake(dbPath, {
  secret: () => process.env.HELMSMAN_WEBHOOK_SECRET,
  routes: () => parseWebhookRoutes(process.env.HELMSMAN_WEBHOOK_ROUTES),
  allowedRepos: () => { const cfg = configStore.current(); return [...Object.keys(cfg.repoProjectMap), ...(cfg.github?.repo ? [cfg.github.repo] : [])]; },
  canStart: repo => pm.canStart(repo).ok, getRun: id => db.getRun(id), isRunActive: id => pm.hasRun(id), launch,
});
setInterval(() => { void webhooks.poll().catch(error => process.stderr.write(`Webhook dispatch failed: ${String(error)}\n`)); }, 5000);

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += chunk.length;
    if (size > 2_000_000) throw new WebhookError('Request payload too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (!raw.length) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url: URL = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (await handleSlackConnection(req, res, url, { oauth: slackOAuth, check: () => slackMcp.check(),
      connected: () => {
        configStore.setOverride('SLACK_TRANSPORT', 'mcp', () => new Date().toISOString());
        slackConnectionGeneration += 1;
        slackSettingsKey = '';
        void pollSlack();
      },
      disconnected: () => { slackConnectionGeneration += 1; slackSettingsKey = ''; },
    })) return;
    if (url.pathname === '/api/webhooks/github' && req.method === 'POST') {
      try {
        const header = (name: string) => { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; };
        const result = webhooks.receive(await readRawBody(req), { signature: header('x-hub-signature-256'), delivery: header('x-github-delivery'), event: header('x-github-event') });
        res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        void webhooks.poll().catch(error => process.stderr.write(`Webhook dispatch failed: ${String(error)}\n`));
      } catch (error) {
        res.writeHead(error instanceof WebhookError ? error.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof WebhookError ? error.message : 'Webhook intake failed' }));
      }
      return;
    }
    if (url.pathname === '/api/workflows' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['coding', 'review'].map(id => workflows.getDefinition(id as 'coding' | 'review')))); return;
    }
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
    if (url.pathname === '/api/config' && req.method === 'PUT' && body && typeof body === 'object' && 'key' in body
      && typeof body.key === 'string' && (body.key.startsWith('SLACK_OAUTH_') || body.key === 'SLACK_MCP_TEAM_ID')
      && (!trustedSlackOrigin(req, configStore.effectiveEnv().SLACK_OAUTH_REDIRECT_URI ?? '')
        || req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Use Helmsman Config to change Slack authentication settings.' })); return;
    }
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      clarificationGate: runId => {
        if (db.getRun(runId)?.status !== 'running') return false;
        clarificationRuntime.poll(runId);
        return !clarificationRuntime.hasUnanswered(runId);
      },
      outcomes,
      campaigns,
      clarifications,
      outboundUsage: () => outboundMeter.snapshot(),
      githubProfile: () => fetchGithubProfile(configStore.current().github),
      context: () => {
        const cfg = configStore.current();
        return {
          repos: repositoryScope(cfg, todos.list()),
          jiraEnabled: cfg.jiraEnabled,
          jiraBaseUrl: cfg.jira?.baseUrl ?? null,
        };
      },
      slack: { snapshot: slackSnapshot, markRead: (id) => {
        const now = new Date().toISOString();
        return id.startsWith('voyage-') ? voyageNotifications.markRead(id, now) : slackStore.markRead(id, now);
      } },
      firefoxBridge,
      slackReviewRequest: (input) => slackReviewRequester.request(input),
      slackReviewRequests: repo => slackReviewRequester.list(repo),
      todos,
      jiraEnabled: () => configStore.current().jiraEnabled,
      dashboard: (repo) => buildDashboardResponse(configStore.effectiveEnv(), new Date(), undefined, repo, todos.list()),
      assignTicket: async (ticketId) => {
        const jira = configStore.current().jira;
        if (!jira) throw new Error('Jira is not configured.');
        await assignIssueToCurrentUser(jira, ticketId);
      },
      submitFeedback: input => createFeedback(configStore.current().github, input),
      triage: (repo) => buildTriageResponse(configStore.effectiveEnv(), undefined, repo),
      bugs: (repo) => buildBugsResponse(configStore.effectiveEnv(), new Date(), undefined, repo),
      db,
      canStart: (repo: string) => pm.canStart(repo),
      launch,
      resumeRun: resumeVoyage,
      stop: (id: string) => pm.stop(id),
      setAutoClaim: (repo: string, enabled: boolean) => scheduler.setEnabled(repo, enabled),
      autoClaimRepos: () => scheduler.enabledRepos(),
      caps: () => {
        const c: AppConfig = configStore.current();
        return { maxAttempts: c.maxAttempts, maxCostUsd: c.maxCostUsd };
      },
      getConfig: () => ({
        config: { ...publicConfig(configStore.current()), ...(!configStore.current().jiraEnabled ? { JIRA_PROJECT: configStore.effectiveEnv().JIRA_PROJECT ?? null, JIRA_ASSIGNEE: configStore.effectiveEnv().JIRA_ASSIGNEE ?? null, JIRA_JQL: configStore.effectiveEnv().JIRA_JQL ?? null } : {}), ...publicSlackSettings(configStore.effectiveEnv()), ...publicSlackReviewSettings(configStore.effectiveEnv()), GITHUB_REVIEW_WATCH_ENABLED: githubReviewEnabled() ? 'true' : 'false' },
        overridden: Object.keys(configStore.overrides()),
        jiraTokenSet: configStore.hasJiraToken(),
        slackOAuthClientSecretSet: Boolean(configStore.effectiveEnv().SLACK_OAUTH_CLIENT_SECRET?.trim()),
      }),
      setConfig: (key: string, value: string): { ok: true } | { ok: false; error: string } => {
        try {
          if (WRITABLE_SECRET_KEYS.includes(key)) configStore.setSecret(key, value, () => new Date().toISOString());
          else configStore.setOverride(key, value, () => new Date().toISOString());
          if (key.startsWith('SLACK_OAUTH_') || key === 'SLACK_MCP_TEAM_ID') {
            slackOAuth.disconnect();
            slackConnectionGeneration += 1;
            slackSettingsKey = '';
          }
          if (SLACK_CONFIG_KEYS.some((configKey) => configKey === key)) {
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
        const repos = repositoryScope(cfg, todos.list());
        return fetchReviewRequestedPrs(cfg.github, repos, repo);
      },
      repoOpenPrs: (repo) => fetchRepoOpenPrs(configStore.current().github, repo),
      localGit: (repo) => {
        const cfg = configStore.current();
        const repos = repositoryScope(cfg, todos.list());
        return getLocalGit(AGENTS_ROOT, repo, repos, {
          activeWorktreePaths: () => db.activeRuns().flatMap(run => run.worktreePath ? [run.worktreePath] : []),
        });
      },
      localGitAction: (repo, body) => {
        const cfg = configStore.current();
        const repos = repositoryScope(cfg, todos.list());
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
    const isPage = /^\/(?:helm|triage|terminal|cmux|bugs|prs?|runs|config|todos|outcomes|campaigns|clarifications)?\/?$/.test(url.pathname);
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
