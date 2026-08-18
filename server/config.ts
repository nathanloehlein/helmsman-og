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
  return { jira, github, repoLabel, repoProjectMap };
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
