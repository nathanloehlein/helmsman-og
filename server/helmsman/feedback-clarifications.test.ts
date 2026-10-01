import { describe, expect, it, vi } from 'vitest';
import type { AgentTask } from './agents/adapter';
import type { Clarification } from '../../src/data/clarifications';
import { readFeedbackClarifications } from './feedback-clarifications';

const task: AgentTask = {
  ticketId: '', title: 'Update feedback', repo: 'o/r', jiraBaseUrl: '',
  clarification: { questionsPath: '/untrusted/questions', answersPath: '/untrusted/answers',
    gateUrl: 'http://127.0.0.1:4000/api/runs/run-1/clarification-gate' },
};
const answer: Clarification = {
  id: 'decision-1', runId: 'run-1', repo: 'o/r', question: 'Keep compatibility?', answer: 'Yes, retain the old API.',
  owner: 'local', contactId: null, required: true, state: 'answered',
  createdAt: '2026-09-30T10:00:00.000Z', answeredAt: '2026-09-30T10:01:00.000Z', timeoutAt: null,
};
const response = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('readFeedbackClarifications', () => {
  it('reads authoritative answers from the current run gate with stable ordering', async () => {
    const second = { ...answer, id: 'decision-2', required: false, owner: 'trusted-contact', contactId: 'contact-1' };
    const fetcher = response({ ready: true, clarifications: [second, answer] });
    const transcript = await readFeedbackClarifications(task, 'run-1', fetcher);
    expect(JSON.parse(transcript)).toEqual([answer, second].map(({ id, question, answer, owner, answeredAt, required }) =>
      ({ id, question, answer, owner, answeredAt, required })));
    expect(await readFeedbackClarifications(task, 'run-1', response({ ready: true, clarifications: [answer, second] }))).toBe(transcript);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(task.clarification!.gateUrl!), {
      method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
    });
  });

  it('returns no transcript without clarification configuration or answered records', async () => {
    const fetcher = response({ ready: true, clarifications: [] });
    expect(await readFeedbackClarifications({ ...task, clarification: undefined }, 'run-1', fetcher)).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFeedbackClarifications(task, 'run-1', fetcher)).toBe('');
  });

  it.each(['pending', 'cancelled', 'timed-out'])('omits optional %s records but rejects required records', async state => {
    const record = { ...answer, state, answer: null, answeredAt: null, required: false };
    expect(await readFeedbackClarifications(task, 'run-1', response({ ready: true, clarifications: [record] }))).toBe('');
    await expect(readFeedbackClarifications(task, 'run-1', response({ ready: true, clarifications: [{ ...record, required: true }] })))
      .rejects.toThrow('unanswered clarification');
  });

  it.each([
    'https://127.0.0.1/api/runs/run-1/clarification-gate',
    'http://example.com/api/runs/run-1/clarification-gate',
    'http://localhost/api/runs/other-run/clarification-gate',
    'http://localhost/api/runs/run-1/clarification-gate?repo=o/r',
    'http://localhost/api/runs/run-1/clarification-gate#other',
    'http://user:pass@localhost/api/runs/run-1/clarification-gate',
    'http://host.docker.internal/clarification-gate',
    'invalid', undefined,
  ])('rejects an untrusted or missing gate URL before fetching: %s', async gateUrl => {
    const fetcher = response({ ready: true, clarifications: [answer] });
    await expect(readFeedbackClarifications({ ...task, clarification: { ...task.clarification!, gateUrl } }, 'run-1', fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['localhost', '[::1]'])('accepts the %s loopback host', async host => {
    const local = { ...task, clarification: { ...task.clarification!, gateUrl: `http://${host}/api/runs/run-1/clarification-gate` } };
    expect(await readFeedbackClarifications(local, 'run-1', response({ ready: true, clarifications: [] }))).toBe('');
  });

  it.each([null, [], { ready: false, clarifications: [answer] }, { ready: true }, { ready: true, clarifications: null },
    { ready: true, clarifications: [answer, answer] }, { ready: true, clarifications: Array(33).fill(answer) },
  ])('rejects malformed, non-ready, duplicate or excessive gate records: %j', async body => {
    await expect(readFeedbackClarifications(task, 'run-1', response(body))).rejects.toThrow('evidence is unavailable');
  });

  it.each([
    null, { ...answer, id: '../bad' }, { ...answer, runId: 'other-run' }, { ...answer, repo: 'other/repo' },
    { ...answer, question: '' }, { ...answer, question: 'x'.repeat(4001) }, { ...answer, answer: null },
    { ...answer, answer: ' ' }, { ...answer, answeredAt: 'yesterday' }, { ...answer, createdAt: null },
    { ...answer, timeoutAt: 'invalid' }, { ...answer, required: 1 }, { ...answer, owner: 'author' },
    { ...answer, contactId: {} }, { ...answer, state: 'approved' }, { ...answer, state: 'cancelled', required: false },
  ])('rejects malformed or cross-run answer evidence: %j', async record => {
    await expect(readFeedbackClarifications(task, 'run-1', response({ ready: true, clarifications: [record] }))).rejects.toThrow('evidence is unavailable');
  });

  it('rejects HTTP, JSON and network errors', async () => {
    await expect(readFeedbackClarifications(task, 'run-1', response({}, 503))).rejects.toThrow('HTTP 503');
    await expect(readFeedbackClarifications(task, 'run-1', vi.fn<typeof fetch>().mockResolvedValue(new Response('bad json')))).rejects.toThrow('evidence is unavailable');
    await expect(readFeedbackClarifications(task, 'run-1', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).rejects.toThrow('offline');
  });
});
