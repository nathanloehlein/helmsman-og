export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  project: string;
  assignee: string;
  jql: string | null;
}

export interface GithubConfig {
  token: string;
  repo: string;
  author: string;
}

export type RepoProjectMap = Record<string, string>;

export interface AppConfig {
  jira: JiraConfig | null;
  github: GithubConfig | null;
  repoLabel: string;
  repoProjectMap: RepoProjectMap;
  botAccountId: string | null;
  maxAttempts: number;
  statusInProgress: string;
  statusInReview: string;
  autoClaimIntervalMs: number;
  agentAdapter: 'claude-code' | 'command';
  agentCmd: string | null;
  maxCostUsd: number | null;
}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string | null {
  const value: string | undefined = env[key];
  return value && value.trim() !== '' ? value : null;
}

function parseRepoProjectMap(raw: string | null): RepoProjectMap {
  const map: RepoProjectMap = {};
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const parts: string[] = pair.split('=').map((part) => part.trim());
    const repo: string | undefined = parts[0];
    const project: string | undefined = parts[1];
    if (repo && project) map[repo] = project;
  }
  return map;
}

export function loadConfig(env: Env): AppConfig {
  const baseUrl: string | null = req(env, 'JIRA_BASE_URL');
  const email: string | null = req(env, 'JIRA_EMAIL');
  const apiToken: string | null = req(env, 'JIRA_API_TOKEN');
  const jira: JiraConfig | null =
    baseUrl && email && apiToken
      ? {
          baseUrl,
          email,
          apiToken,
          project: req(env, 'JIRA_PROJECT') ?? 'AIROBUILD',
          assignee: req(env, 'JIRA_ASSIGNEE') ?? 'currentUser()',
          jql: req(env, 'JIRA_JQL'),
        }
      : null;

  const token: string | null = req(env, 'GITHUB_TOKEN');
  const repo: string | null = req(env, 'GITHUB_REPO');
  const author: string | null = req(env, 'GITHUB_PR_AUTHOR');
  const github: GithubConfig | null =
    token && author ? { token, repo: repo ?? '', author } : null;

  const repoLabel: string = repo ?? (github ? `@${github.author}` : 'backlog-runner');
  const repoProjectMap: RepoProjectMap = parseRepoProjectMap(req(env, 'REPO_PROJECT_MAP'));
  const botAccountId: string | null = req(env, 'BOT_ACCOUNT_ID');
  const maxAttemptsRaw: string | null = req(env, 'AGENT_MAX_ATTEMPTS');
  const parsedMaxAttempts: number = maxAttemptsRaw ? parseInt(maxAttemptsRaw, 10) : NaN;
  const maxAttempts: number = Number.isFinite(parsedMaxAttempts) ? parsedMaxAttempts : 1;
  const statusInProgress: string = req(env, 'JIRA_STATUS_IN_PROGRESS') ?? 'In Progress';
  const statusInReview: string = req(env, 'JIRA_STATUS_IN_REVIEW') ?? 'In Review';
  const autoClaimIntervalMsRaw: string | null = req(env, 'AUTO_CLAIM_INTERVAL_MS');
  const parsedAutoClaimIntervalMs: number = autoClaimIntervalMsRaw ? parseInt(autoClaimIntervalMsRaw, 10) : NaN;
  const autoClaimIntervalMs: number = Number.isFinite(parsedAutoClaimIntervalMs) ? parsedAutoClaimIntervalMs : 60000;
  const agentCmd: string | null = req(env, 'AGENT_CMD');
  const agentAdapter: 'claude-code' | 'command' =
    req(env, 'AGENT_ADAPTER') === 'command' ? 'command' : 'claude-code';
  const maxCostRaw: string | null = req(env, 'AGENT_MAX_COST_USD');
  const parsedMaxCost: number = maxCostRaw ? parseFloat(maxCostRaw) : NaN;
  const maxCostUsd: number | null = Number.isFinite(parsedMaxCost) ? parsedMaxCost : null;
  return {
    jira,
    github,
    repoLabel,
    repoProjectMap,
    botAccountId,
    maxAttempts,
    statusInProgress,
    statusInReview,
    autoClaimIntervalMs,
    agentAdapter,
    agentCmd,
    maxCostUsd,
  };
}

function formatAssignee(assignee: string): string {
  return /\(\s*\)$/.test(assignee) ? assignee : `"${assignee}"`;
}

export function buildQueueJql(jira: JiraConfig): string {
  if (jira.jql) return jira.jql;
  return `project = "${jira.project}" AND assignee = ${formatAssignee(jira.assignee)} AND status = Backlog ORDER BY priority`;
}

export function buildActiveJql(jira: JiraConfig): string {
  return `project = "${jira.project}" AND assignee = ${formatAssignee(jira.assignee)} AND status IN ("In Progress","In Review","Done") AND updated >= -7d ORDER BY updated DESC`;
}
