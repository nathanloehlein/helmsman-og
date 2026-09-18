import type { JiraConfig } from '../config';

export interface JiraActions {
  assign(ticketId: string, accountId: string): Promise<void>;
  transition(ticketId: string, statusName: string): Promise<boolean>;
}

interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

interface JiraTransitionsResponse {
  transitions?: JiraTransition[];
}

function basicAuth(jira: JiraConfig): string {
  return Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
}

function authHeaders(jira: JiraConfig): Record<string, string> {
  return {
    Authorization: `Basic ${basicAuth(jira)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function issueUrl(jira: JiraConfig, ticketId: string, suffix: string): URL {
  return new URL(`/rest/api/3/issue/${encodeURIComponent(ticketId)}/${suffix}`, jira.baseUrl);
}

/**
 * Builds a {@link JiraActions} that assigns and transitions Jira issues via
 * the Jira Cloud REST v3 API. Both methods are fail-soft: network errors and
 * non-2xx responses never throw.
 */
export function makeJiraActions(jira: JiraConfig, fetchImpl: typeof fetch = fetch): JiraActions {
  async function assign(ticketId: string, accountId: string): Promise<void> {
    try {
      await fetchImpl(issueUrl(jira, ticketId, 'assignee'), {
        method: 'PUT',
        headers: authHeaders(jira),
        body: JSON.stringify({ accountId }),
      });
    } catch {
      return;
    }
  }

  async function transition(ticketId: string, statusName: string): Promise<boolean> {
    try {
      const url: URL = issueUrl(jira, ticketId, 'transitions');
      const getRes: Response = await fetchImpl(url, { headers: authHeaders(jira) });
      if (!getRes.ok) return false;

      const body: JiraTransitionsResponse = await getRes.json();
      const target: string = statusName.toLowerCase();
      const match: JiraTransition | undefined = body.transitions?.find(
        (candidate: JiraTransition): boolean => candidate.to.name.toLowerCase() === target,
      );
      if (!match) return false;

      const postRes: Response = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(jira),
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      return postRes.ok;
    } catch {
      return false;
    }
  }

  return { assign, transition };
}

export function makeLiveJiraActions(current: () => JiraConfig | null, fetchImpl: typeof fetch = fetch): JiraActions {
  const guardedFetch: typeof fetch = (input, init) => current()
    ? fetchImpl(input, init)
    : Promise.resolve(new Response(null, { status: 409 }));
  return {
    assign: async (ticketId, accountId) => {
      const jira = current();
      if (jira) await makeJiraActions(jira, guardedFetch).assign(ticketId, accountId);
    },
    transition: async (ticketId, status) => {
      const jira = current();
      return jira ? makeJiraActions(jira, guardedFetch).transition(ticketId, status) : false;
    },
  };
}
