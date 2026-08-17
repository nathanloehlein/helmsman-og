import type { JiraConfig } from './config';
import { buildActiveJql, buildQueueJql } from './config';
import type { JiraIssue } from './types';

const FIELDS: string = 'summary,status,priority,resolutiondate';

async function search(jira: JiraConfig, jql: string, expandChangelog: boolean): Promise<JiraIssue[]> {
  const url: URL = new URL('/rest/api/3/search/jql', jira.baseUrl);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('maxResults', '100');
  if (expandChangelog) url.searchParams.set('expand', 'changelog');

  const auth: string = Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
  const body: { issues?: JiraIssue[] } = await res.json();
  return body.issues ?? [];
}

export function fetchQueueIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  return search(jira, buildQueueJql(jira), false);
}

export function fetchActiveIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  return search(jira, buildActiveJql(jira), true);
}
