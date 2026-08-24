import type { JiraConfig } from './config';
import { buildActiveJql, buildQueueJql } from './config';
import type { JiraHistory, JiraIssue } from './types';

const FIELDS: string = 'summary,status,priority,resolutiondate';

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
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
  const body: { changelog?: { histories?: JiraHistory[] } } = await res.json();
  return body.changelog?.histories ?? [];
}

export async function fetchIssueSummary(jira: JiraConfig, key: string): Promise<string | null> {
  try {
    const url: URL = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, jira.baseUrl);
    url.searchParams.set('fields', 'summary');
    const res: Response = await fetch(url, {
      headers: { Authorization: `Basic ${basicAuth(jira)}`, Accept: 'application/json' },
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
