import { afterEach, describe, expect, it } from 'vitest';
import {
  ClarificationValidationError,
  MAX_CLARIFICATIONS_PER_RUN,
  MAX_CLARIFICATION_PROTOCOL_LINE_BYTES,
  openClarificationStore,
  parseClarificationQuestionLine,
  type ClarificationStore,
} from './clarifications';

const runs = new Map<string, { repo: string; status: string }>();
const stores: ClarificationStore[] = [];
let timestamp = '2026-09-18T12:00:00.000Z';

function openStore(): ClarificationStore {
  const store = openClarificationStore(':memory:', { getRun: id => runs.get(id) ?? null }, () => timestamp);
  stores.push(store);
  return store;
}

function question(id: string, overrides: Record<string, unknown> = {}) {
  return { kind: 'question', id, required: true, prompt: 'Which galleon should continue?', ...overrides };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  runs.clear();
  timestamp = '2026-09-18T12:00:00.000Z';
});

describe('clarifications', () => {
  it('binds questions to the persisted active run and deduplicates per run', () => {
    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();

    const first = store.ingestQuestion('run_1', { ...question('question_1'), repo: 'attacker/repo' });
    const repeated = store.ingestQuestion('run_1', question('question_1'));

    expect(first).toMatchObject({ repo: 'org/galleon', required: true, state: 'pending', owner: 'local' });
    expect(repeated).toEqual(first);
    expect(() => store.ingestQuestion('run_1', question('question_1', { prompt: 'A different question' }))).toThrow('conflicts');
    expect(() => store.ingestQuestion('run_2', question('question_1'))).toThrow(ClarificationValidationError);
    expect(() => store.ingestQuestion('run_1', question('question_2', { required: 'yes' }))).toThrow(ClarificationValidationError);
  });

  it('uses an enabled default trusted contact only as question metadata', () => {
    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();
    const contact = store.saveContact({ name: 'Morgan', address: 'morgan@example.test' });

    const trusted = store.ingestQuestion('run_1', question('question_1', { owner: 'trusted-contact' }));
    store.saveContact({ ...contact, enabled: false });
    const local = store.ingestQuestion('run_1', question('question_2', { owner: 'trusted-contact' }));

    expect(trusted).toMatchObject({ owner: 'trusted-contact', contactId: contact.id });
    expect(local).toMatchObject({ owner: 'local', contactId: null });
  });

  it('times out without creating an answer and keeps required timeout unanswered', () => {
    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();
    store.ingestQuestion('run_1', question('question_1', { timeoutAt: '2026-09-18T12:01:00.000Z' }));
    store.ingestQuestion('run_1', question('question_2', { required: false, timeoutAt: '2026-09-18T12:01:00.000Z' }));

    expect(store.timeoutDue('2026-09-18T12:01:00.000Z')).toBe(2);
    expect(store.listForRun('run_1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'question_1', state: 'timed-out', answer: null }),
      expect.objectContaining({ id: 'question_2', state: 'timed-out', answer: null }),
    ]));
    expect(store.hasRequiredTimedOut('run_1')).toBe(true);
    expect(store.hasRequiredUnanswered('run_1')).toBe(true);
  });

  it('rejects an answer after a run becomes terminal and cancels the pending question', () => {
    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();
    store.ingestQuestion('run_1', question('question_1'));
    runs.set('run_1', { repo: 'org/galleon', status: 'completed' });

    expect(() => store.answer('question_1', { answer: 'Proceed' })).toThrow('Run is not active');
    expect(store.listForRun('run_1')[0]).toMatchObject({ state: 'cancelled', answer: null });
  });

  it('rejects an answer after its deadline even before periodic timeout processing', () => {
    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();
    store.ingestQuestion('run_1', question('question_1', { timeoutAt: '2026-09-18T05:00:00-07:00' }));
    timestamp = '2026-09-18T12:00:00.000Z';

    expect(() => store.answer('question_1', { answer: 'Proceed' })).toThrow('timed out');
    expect(store.listForRun('run_1')[0]).toMatchObject({ state: 'timed-out', answer: null, timeoutAt: '2026-09-18T12:00:00.000Z' });
  });

  it('cancels questions for missing or terminal runs during cleanup', () => {
    runs.set('run_1', { repo: 'org/one', status: 'running' });
    runs.set('run_2', { repo: 'org/two', status: 'running' });
    const store = openStore();
    store.ingestQuestion('run_1', question('question_1'));
    store.ingestQuestion('run_2', question('question_2'));
    runs.delete('run_1');
    runs.set('run_2', { repo: 'org/two', status: 'failed' });

    expect(store.cleanupOrphans()).toBe(2);
    expect(store.list().every(item => item.state === 'cancelled')).toBe(true);
  });

  it('bounds protocol input and question count', () => {
    expect(() => parseClarificationQuestionLine('x'.repeat(MAX_CLARIFICATION_PROTOCOL_LINE_BYTES + 1))).toThrow('too large');
    expect(() => parseClarificationQuestionLine('{')).toThrow('Invalid clarification protocol JSON');
    expect(parseClarificationQuestionLine(JSON.stringify(question('question_1')))).toMatchObject({ owner: 'local' });

    runs.set('run_1', { repo: 'org/galleon', status: 'running' });
    const store = openStore();
    for (let index = 0; index < MAX_CLARIFICATIONS_PER_RUN; index += 1) {
      store.ingestQuestion('run_1', question(`question_${index}`));
    }
    expect(() => store.ingestQuestion('run_1', question('question_extra'))).toThrow('Too many');
  });
});

it('selects a registered Jira assignee from persisted task hints and ignores question recipient fields', () => {
  const store = openClarificationStore(':memory:', { getRun: () => ({ repo: 'o/r', status: 'running', taskJson: JSON.stringify({ contactHints: { assigneeId: 'jira-account-1' } }) }) });
  const contact = store.saveContact({ name: 'Assigned owner', address: 'jira-account-1', enabled: true });
  const question = store.ingestQuestion('run-1', { kind: 'question', id: 'question-1', prompt: 'Which behavior?', required: true, owner: 'trusted-contact', contactId: 'untrusted' });
  expect(question.contactId).toBe(contact.id);
  store.close();
});
