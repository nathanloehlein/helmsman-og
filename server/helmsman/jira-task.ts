import type { JiraConfig } from '../config';
import type { AgentTask } from './agents/adapter';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function jiraTask(
  jira: JiraConfig | null,
  input: { ticketId: string; title?: string; repo: string },
  fetcher: typeof fetch = fetch,
): Promise<AgentTask> {
  if (!jira) throw new Error(`Cannot load requirements for ${input.ticketId}: Jira is not configured.`);
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(input.ticketId)}`, jira.baseUrl);
  url.searchParams.set('fields', '*all');
  url.searchParams.set('expand', 'names');
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Cannot load requirements for ${input.ticketId}: Jira request failed. No agent was started.`);
  }
  if (!response.ok) throw new Error(`Cannot load requirements for ${input.ticketId}: Jira returned HTTP ${response.status}. Check the configured Jira account's access. No agent was started.`);
  const issue = record(await response.json().catch(() => null));
  const fields = record(issue?.fields);
  if (!fields || typeof fields.summary !== 'string' || !fields.summary.trim()) {
    throw new Error(`Cannot load requirements for ${input.ticketId}: Jira returned invalid issue details. No agent was started.`);
  }
  const names = record(issue?.names);
  const requirements: Record<string, unknown> = { summary: fields.summary, description: fields.description ?? null };
  for (const [key, name] of Object.entries(names ?? {})) {
    if (typeof name === 'string' && /acceptance[\s_-]*criteria/i.test(name) && fields[key] != null) requirements[name] = fields[key];
  }
  if (Array.isArray(fields.attachment)) {
    requirements.attachments = fields.attachment.flatMap(value => {
      const attachment = record(value);
      return typeof attachment?.filename === 'string' && typeof attachment.content === 'string'
        ? [{ filename: attachment.filename, url: attachment.content }] : [];
    });
  }
  return {
    ticketId: input.ticketId,
    title: input.title ?? fields.summary,
    repo: input.repo,
    jiraBaseUrl: jira.baseUrl,
    jiraContext: JSON.stringify(requirements, null, 2),
  };
}
