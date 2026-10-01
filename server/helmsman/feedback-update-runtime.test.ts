// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from './agents/adapter';
import type { FeedbackDecision } from './feedback-update-workflow';
import { waitForFeedbackDecisions } from './feedback-update-runtime';
import { canCreateFileSymlink } from '../test-support/platform';

vi.mock('node:timers/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:timers/promises')>();
  return { ...original, setTimeout: (milliseconds: number, value?: unknown, options?: { signal?: AbortSignal }) => original.setTimeout(Math.min(milliseconds, 5), value, options) };
});

interface Question { kind: string; id: string; required: boolean; prompt: string; owner: string; timeoutAt: string }
const decision: FeedbackDecision = { sourceUrl: 'https://github.com/org/repo/pull/12#discussion_r123', question: 'May prospective-only protection merge?' };
const directories: string[] = [];
const active: Array<{ abort: AbortController; settled: Promise<unknown> }> = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-feedback-decisions-'));
  directories.push(root);
  const task: AgentTask = { ticketId: 'T-1', title: 'Address feedback', repo: 'org/repo', jiraBaseUrl: '',
    clarification: { questionsPath: join(root, 'questions.jsonl'), answersPath: join(root, 'answers.jsonl') } };
  return { root, task, questionsPath: task.clarification!.questionsPath, answersPath: task.clarification!.answersPath };
}

function start(task: AgentTask, decisions = [decision], timeoutMs = 2000) {
  const abort = new AbortController();
  const pending = waitForFeedbackDecisions(task, decisions, abort.signal, timeoutMs);
  const settled = pending.then(value => ({ value }), error => ({ error }));
  active.push({ abort, settled });
  return { abort, pending, settled };
}

async function questions(path: string, count = 1): Promise<Question[]> {
  let records: Question[] = [];
  await vi.waitFor(async () => {
    records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Question);
    expect(records).toHaveLength(count);
  }, { timeout: 1500, interval: 5 });
  return records;
}

function answer(question: Question, overrides: Record<string, unknown> = {}) {
  return { kind: 'answer', id: question.id, state: 'answered', answer: 'Proceed with the tracked remediation plan.', ...overrides };
}

async function writeAnswers(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, values.map(value => JSON.stringify(value)).join('\n') + '\n');
}

afterEach(async () => {
  for (const entry of active) entry.abort.abort();
  await Promise.all(active.map(entry => entry.settled));
  active.length = 0;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('waitForFeedbackDecisions', () => {
  it('publishes local required questions with finding links and resumes only after every matching answer', async () => {
    const env = await setup();
    const second = { sourceUrl: 'https://github.com/org/repo/pull/12#issuecomment-456', question: 'Which migration owner is responsible?' };
    const before = Date.now();
    const wait = start(env.task, [decision, second]);
    const records = await questions(env.questionsPath, 2);
    expect(new Set(records.map(question => question.id)).size).toBe(2);
    for (const [index, question] of records.entries()) {
      expect(question).toMatchObject({ kind: 'question', required: true, owner: 'local' });
      expect(question.id).toMatch(/^[a-f\d-]{36}$/);
      expect(Date.parse(question.timeoutAt)).toBeGreaterThanOrEqual(before + 2000);
      expect(question.prompt).toContain([decision, second][index]?.sourceUrl);
    }
    const finished = vi.fn();
    void wait.settled.then(finished);
    await writeAnswers(env.answersPath, [answer(records[0]!), answer(records[1]!, { id: 'another-run-question' })]);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(finished).not.toHaveBeenCalled();
    await writeAnswers(env.answersPath, [answer(records[0]!), answer(records[1]!, { answer: 'The platform team owns migration.' })]);
    const context = await wait.pending;
    expect(context).toContain(decision.sourceUrl);
    expect(context).toContain(second.question);
    expect(context).toContain('Answer: Proceed with the tracked remediation plan.');
    expect(context).toContain('Answer: The platform team owns migration.');
  });

  it.each([
    { state: 'cancelled' }, { state: 'timed-out' }, { state: 'pending' },
    { answer: null }, { answer: '' }, { answer: '   ' },
  ])('rejects a matching unusable answer %j', async overrides => {
    const env = await setup();
    const wait = start(env.task);
    const [question] = await questions(env.questionsPath);
    await writeAnswers(env.answersPath, [answer(question!, overrides)]);
    await expect(wait.pending).rejects.toThrow('cancelled, expired, or unanswered');
  });

  it('does not treat a missing answer file or timeout as acceptance', async () => {
    const env = await setup();
    const wait = start(env.task, [decision], 25);
    await expect(wait.pending).rejects.toThrow('expired without an answer');
  });

  it('does not accept partial JSONL records until their newline is present', async () => {
    const env = await setup();
    const wait = start(env.task);
    const [question] = await questions(env.questionsPath);
    const finished = vi.fn();
    void wait.settled.then(finished);
    const record = JSON.stringify(answer(question!));
    await writeFile(env.answersPath, record);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(finished).not.toHaveBeenCalled();
    await writeFile(env.answersPath, `${record}\n`);
    await expect(wait.pending).resolves.toContain('Answer: Proceed');
  });

  it('rejects abort while awaiting a required decision', async () => {
    const env = await setup();
    const wait = start(env.task);
    await questions(env.questionsPath);
    wait.abort.abort();
    await expect(wait.pending).rejects.toThrow();
  });

  it('rejects an already aborted signal', async () => {
    const env = await setup();
    await expect(waitForFeedbackDecisions(env.task, [decision], AbortSignal.abort(), 2000)).rejects.toThrow('wait stopped');
  });

  it.each([{ decisions: [] }, { decisions: Array.from({ length: 33 }, () => decision) }])('rejects an invalid decision count before publishing', async ({ decisions }) => {
    const env = await setup();
    await expect(start(env.task, decisions).pending).rejects.toThrow('handoff is unavailable');
    await expect(readFile(env.questionsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing handoff configuration', async () => {
    const { task } = await setup();
    await expect(start({ ...task, clarification: undefined }).pending).rejects.toThrow('handoff is unavailable');
  });

  it('rejects malformed handoff paths', async () => {
    const { task } = await setup();
    await expect(start({ ...task, clarification: {} as AgentTask['clarification'] }).pending).rejects.toThrow();
  });

  it('rejects malformed answer JSON', async () => {
    const env = await setup();
    await writeFile(env.answersPath, '{broken\n');
    await expect(start(env.task).pending).rejects.toThrow();
  });

  it.skipIf(!canCreateFileSymlink()).each(['questions', 'answers'] as const)('rejects a symlink at the %s path without changing its target', async kind => {
    const env = await setup();
    const target = join(env.root, 'target');
    await writeFile(target, 'keep original bytes');
    await symlink(target, kind === 'questions' ? env.questionsPath : env.answersPath);
    await expect(start(env.task).pending).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep original bytes');
  });

  it.each(['questions', 'answers'] as const)('rejects oversized %s input', async kind => {
    const env = await setup();
    await writeFile(kind === 'questions' ? env.questionsPath : env.answersPath, Buffer.alloc((kind === 'questions' ? 400 : 512) * 1024 + 1, 'x'));
    await expect(start(env.task).pending).rejects.toThrow(kind === 'questions' ? 'exceed protocol limits' : 'Invalid clarification answers file');
  });

  it('rejects a question exceeding the stored prompt limit', async () => {
    const env = await setup();
    await expect(start(env.task, [{ ...decision, question: 'x'.repeat(4001) }]).pending).rejects.toThrow('exceed protocol limits');
    expect(await readFile(env.questionsPath, 'utf8')).toBe('');
  });
});
