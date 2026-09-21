import { createHash } from 'node:crypto';
import type { JiraConfig } from './config';
import {
  buildActiveJql,
  buildMineOpenJql,
  buildQueueJql,
  buildUnassignedBacklogJql,
  buildUnassignedTodoJql,
  buildOpenBugsJql,
  buildOldestOpenBugJql,
  buildResolved90Jql,
} from './config';
import type { JiraHistory, JiraIssue } from './types';
import { readHttpFailure } from './http-failure';

export interface TriageGroups {
  unassignedBacklog: JiraIssue[];
  unassignedTodo: JiraIssue[];
  mineOpen: JiraIssue[];
}

const FIELDS: string = 'summary,description,status,priority,resolutiondate,updated';
const MINE_OPEN_CACHE_MS = 5 * 60_000;
const MINE_OPEN_CACHE_LIMIT = 32;
type MineOpenCache = Map<string, { expiresAt: number; result: Promise<JiraIssue[]> }>;
const mineOpenCaches = new WeakMap<typeof fetch, MineOpenCache>();

const BUG_FIELDS: string = 'summary,description,priority,duedate,resolutiondate,created,customfield_14808';

export interface BugIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    priority: { name: string } | null;
    duedate: string | null;
    resolutiondate: string | null;
    created: string;
    customfield_14808: { value: string } | null;
  };
}

function basicAuth(jira: JiraConfig): string {
  return Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
}

async function search(jira: JiraConfig, jql: string): Promise<JiraIssue[]> {
  const url: URL = new URL('/rest/api/3/search/jql', jira.baseUrl);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('maxResults', '100');

  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await readHttpFailure(res)}`);
  const body: { issues?: JiraIssue[] } = await res.json();
  return body.issues ?? [];
}

async function fetchChangelog(jira: JiraConfig, key: string): Promise<JiraHistory[]> {
  const url: URL = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, jira.baseUrl);
  url.searchParams.set('expand', 'changelog');
  url.searchParams.set('fields', FIELDS);

  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await readHttpFailure(res)}`);
  const body: { changelog?: { histories?: JiraHistory[] } } = await res.json();
  return body.changelog?.histories ?? [];
}

export async function fetchIssueSummary(jira: JiraConfig, key: string): Promise<string | null> {
  try {
    const url: URL = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, jira.baseUrl);
    url.searchParams.set('fields', 'summary');
    const res: Response = await fetch(url, {
      headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body: { fields?: { summary?: string } } = await res.json();
    return body.fields?.summary ?? null;
  } catch {
    return null;
  }
}

export function fetchQueueIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  return search(jira, buildQueueJql(jira));
}

export function fetchMineOpenIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  let cache = mineOpenCaches.get(fetch);
  if (!cache) {
    cache = new Map();
    mineOpenCaches.set(fetch, cache);
  }
  const identity = createHash('sha256').update(JSON.stringify([jira.email, jira.apiToken])).digest('hex');
  const key = JSON.stringify([jira.baseUrl, identity, jira.project, jira.assignee]);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  for (const [cacheKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cacheKey);
  }
  if (cache.size >= MINE_OPEN_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  const result = search(jira, buildMineOpenJql(jira));
  cache.set(key, { expiresAt: now + MINE_OPEN_CACHE_MS, result });
  return result;
}

export async function fetchTriageGroups(
  jira: JiraConfig,
  statusBacklog: string,
  statusTodo: string,
): Promise<TriageGroups> {
  const results: PromiseSettledResult<JiraIssue[]>[] = await Promise.allSettled([
    search(jira, buildUnassignedBacklogJql(jira, statusBacklog)),
    search(jira, buildUnassignedTodoJql(jira, statusTodo)),
    fetchMineOpenIssues(jira),
  ]);
  if (results.every((r) => r.status === 'rejected')) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  const value = (i: number): JiraIssue[] =>
    results[i]!.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<JiraIssue[]>).value : [];
  return { unassignedBacklog: value(0), unassignedTodo: value(1), mineOpen: value(2) };
}

export async function fetchActiveIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = await search(jira, buildActiveJql(jira));
  return Promise.all(
    issues.map(
      async (issue: JiraIssue): Promise<JiraIssue> => ({
        ...issue,
        changelog: { histories: await fetchChangelog(jira, issue.key) },
      }),
    ),
  );
}

export async function verifyJiraAuth(jira: JiraConfig): Promise<void> {
  const url: URL = new URL('/rest/api/3/myself', jira.baseUrl);
  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira auth ${res.status}: ${await readHttpFailure(res)}`);
}

export async function fetchApproxCount(jira: JiraConfig, jql: string): Promise<number> {
  const url: URL = new URL('/rest/api/3/search/approximate-count', jira.baseUrl);
  const res: Response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(jira)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jql }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await readHttpFailure(res)}`);
  const body: { count?: number } = await res.json();
  return body.count ?? 0;
}

async function searchBugs(jira: JiraConfig, jql: string, maxResults: number): Promise<BugIssue[]> {
  const url: URL = new URL('/rest/api/3/search/jql', jira.baseUrl);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', BUG_FIELDS);
  url.searchParams.set('maxResults', String(maxResults));
  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await readHttpFailure(res)}`);
  const body: { issues?: BugIssue[] } = await res.json();
  return body.issues ?? [];
}

export function fetchOpenBugs(jira: JiraConfig, project: string): Promise<BugIssue[]> {
  return searchBugs(jira, buildOpenBugsJql(project), 100);
}

export async function fetchOldestOpenBug(
  jira: JiraConfig,
  project: string,
): Promise<{ key: string; created: string } | null> {
  const issues: BugIssue[] = await searchBugs(jira, buildOldestOpenBugJql(project), 1);
  const first: BugIssue | undefined = issues[0];
  return first ? { key: first.key, created: first.fields.created } : null;
}

export async function fetchResolvedDurations(jira: JiraConfig, project: string, days: number): Promise<number[]> {
  const issues: BugIssue[] = await searchBugs(jira, buildResolved90Jql(project, days), 100);
  const out: number[] = [];
  for (const i of issues) {
    const r: string | null = i.fields.resolutiondate;
    if (!r) continue;
    const ms: number = Date.parse(r) - Date.parse(i.fields.created);
    if (!Number.isNaN(ms)) out.push(Math.max(0, Math.round(ms / 86_400_000)));
  }
  return out;
}

export async function assignIssueToCurrentUser(jira: JiraConfig, ticketId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const headers = { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const profile = await fetchImpl(new URL('/rest/api/3/myself', jira.baseUrl), { headers, signal: AbortSignal.timeout(10_000) });
  if (!profile.ok) throw new Error(`Jira identity lookup failed (${profile.status}).`);
  const user = await profile.json() as { accountId?: unknown } | null;
  if (typeof user?.accountId !== 'string' || !user.accountId.trim()) throw new Error('Jira did not return your account ID.');
  const response = await fetchImpl(new URL(`/rest/api/3/issue/${encodeURIComponent(ticketId)}/assignee`, jira.baseUrl), {
    method: 'PUT', headers, body: JSON.stringify({ accountId: user.accountId }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Jira assignment failed (${response.status}).`);
  mineOpenCaches.delete(fetchImpl);
}
