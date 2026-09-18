import { describe, expect, it, vi } from 'vitest';
import { jiraTask } from './jira-task';
import type { JiraConfig } from '../config';
import { buildPrompt } from './agents/prompt';

const jira: JiraConfig = { baseUrl: 'https://jira.example.com', email: 'bot@example.com', apiToken: 'private-token', project: 'PROJ', assignee: 'bot', jql: null };
const input = { ticketId: 'PROJ-1', title: 'Supplied title', repo: 'owner/repo' };

describe('authenticated Jira voyage context', () => {
  it('fetches requirements even with a supplied title, preserves rich text and named acceptance fields, and excludes unrelated fields', async () => {
    const description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fill the requested aspect ratio.', marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }] }] }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      fields: {
        summary: 'Canonical title', description, customfield_42: 'No distortion.',
        unrelated: 'Private field', attachment: [null, { filename: 'example.png', content: 'https://jira.example.com/attachment/1', author: { emailAddress: 'private@example.com' } }],
      }, names: { customfield_42: 'Acceptance Criteria', unrelated: 'Unrelated' },
    })));
    const task = await jiraTask(jira, input, fetcher);
    expect(task.title).toBe(input.title);
    expect(JSON.parse(task.jiraContext ?? '{}')).toEqual({
      summary: 'Canonical title', description, 'Acceptance Criteria': 'No distortion.',
      attachments: [{ filename: 'example.png', url: 'https://jira.example.com/attachment/1' }],
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toContain('/rest/api/3/issue/PROJ-1');
    expect(new URL(String(url)).searchParams.get('expand')).toBe('names');
    expect(init?.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('bot@example.com:private-token').toString('base64')}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(task)).not.toContain('private-token');
    expect(JSON.stringify(task)).not.toContain('private@example.com');
    const persistedTask = JSON.parse(JSON.stringify(task));
    for (const stage of ['implement', 'review', 'fix'] as const) {
      const prompt = buildPrompt({ ...persistedTask, prePr: { stage, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/tmp/report.json' } });
      expect(prompt).toContain('Authenticated Jira requirements snapshot');
      expect(prompt).toContain('Fill the requested aspect ratio.');
      expect(prompt).toContain('No distortion.');
      expect(prompt).toContain('https://example.com/spec');
    }
    expect(buildPrompt(persistedTask)).toContain('Fill the requested aspect ratio.');
  });

  it('accepts a valid issue with no description or acceptance field', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ fields: { summary: 'Valid title', description: null }, names: null })));
    const task = await jiraTask(jira, { ...input, title: undefined }, fetcher);
    expect(task.title).toBe('Valid title');
    expect(JSON.parse(task.jiraContext ?? '{}')).toEqual({ summary: 'Valid title', description: null });
  });

  it.each([401, 403, 404, 500])('fails before agent launch on HTTP %s without exposing response bodies', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream error', { status }));
    await expect(jiraTask(jira, input, fetcher)).rejects.toThrow(`Jira returned HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { fields: null }, { fields: { summary: 1 } }, { fields: { summary: '' } }])('rejects malformed issue details: %j', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(jiraTask(jira, input, fetcher)).rejects.toThrow('invalid issue details');
  });

  it('reports unavailable configuration and network failure without leaking credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token'));
    await expect(jiraTask(null, input, fetcher)).rejects.toThrow('Jira is not configured');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(jiraTask(jira, input, fetcher)).rejects.toThrow('Jira request failed. No agent was started.');
  });
});
