import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountClarifications, renderClarifications } from './renderClarifications';
import * as client from './data/clarificationClient';
import type { Clarification } from './data/clarifications';
import { setPirateMode } from './logic/terminology';

vi.mock('./data/clarificationClient', () => ({ answerClarification: vi.fn(), createClarification: vi.fn(),
  fetchClarifications: vi.fn(), fetchTrustedContacts: vi.fn(), saveTrustedContact: vi.fn() }));

const controllers: Array<ReturnType<typeof mountClarifications>> = [];
const question = (patch: Partial<Clarification> = {}): Clarification => ({ id: 'question-1', runId: 'run-1', repo: 'org/app',
  question: 'Should the existing API stay available?', required: true, owner: 'local', contactId: null, state: 'pending',
  answer: null, createdAt: '2026-09-19T00:00:00Z', timeoutAt: null, answeredAt: null, ...patch });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mount(repo: () => string | null = () => 'org/app') {
  const container = document.createElement('main');
  document.body.append(container);
  const controller = mountClarifications(container, { repo });
  controllers.push(controller);
  return { container, controller };
}

function answerForm(container: HTMLElement, id = 'question-1'): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>(`form[data-answer="${id}"]`);
  if (!form) throw new Error(`Missing answer form for ${id}`);
  return form;
}

function draft(container: HTMLElement, value: string, id = 'question-1') {
  const textarea = answerForm(container, id).querySelector<HTMLTextAreaElement>('textarea[name="answer"]');
  if (!textarea) throw new Error('Missing answer textarea');
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flushResponses() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.mocked(client.fetchClarifications).mockResolvedValue([question()]);
  vi.mocked(client.fetchTrustedContacts).mockResolvedValue([]);
});

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.destroy());
  document.body.innerHTML = '';
  vi.resetAllMocks();
  setPirateMode(true);
  localStorage.clear();
});

describe('agent question rendering', () => {
  it.each([false, true])('uses Agent Questions in pirate mode %s and requires no contact setup', enabled => {
    setPirateMode(enabled);
    document.body.innerHTML = renderClarifications([question()], [], 'org/app', null);
    expect(document.querySelector('h1')?.textContent).toBe('Agent Questions');
    expect(document.querySelector('.clarification-create')).toBeNull();
    const settings = document.querySelector<HTMLDetailsElement>('details[data-contact-settings]');
    expect(settings).not.toBeNull();
    expect(settings?.open).toBe(false);
    expect(settings?.querySelector('summary')?.textContent).toContain('Optional contact settings');
    expect(answerForm(document.body).querySelector('button')?.textContent?.trim()).toBe('Send answer');
    expect(answerForm(document.body).querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(answerForm(document.body).closest('details')).toBeNull();
  });

  it('puts pending questions before collapsed history without offering answers for resolved items', () => {
    document.body.innerHTML = renderClarifications([
      question({ id: 'answered', question: 'Resolved question', state: 'answered', answer: 'Keep the API.' }),
      question(),
      question({ id: 'expired', question: 'Expired question', state: 'timed-out' }),
      question({ id: 'cancelled', question: 'Cancelled question', state: 'cancelled' }),
    ], [], null, null);
    expect(document.body.textContent).toContain('Questions awaiting your answer');
    const cards = [...document.querySelectorAll('.clarification-card')];
    expect(cards[0]?.textContent).toContain(question().question);
    expect(document.querySelectorAll('form[data-answer]')).toHaveLength(1);
    for (const text of ['Resolved question', 'Expired question', 'Cancelled question']) {
      const card = cards.find(item => item.textContent?.includes(text));
      const history = card?.closest('details');
      expect(history).not.toBeNull();
      expect(history?.open).toBe(false);
    }
  });

  it('links a question to its own scoped run and escapes agent and answer content', () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    document.body.innerHTML = renderClarifications([
      question({ repo: 'org/other', runId: 'run-2', question: unsafe }),
      question({ id: 'answered', state: 'answered', answer: '<script>bad()</script>' }),
    ], [], null, null);
    const link = document.querySelector<HTMLAnchorElement>('.clarification-card a[href]');
    expect(link).not.toBeNull();
    const url = new URL(link!.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/runs');
    expect(url.searchParams.get('repo')).toBe('org/other');
    expect(url.searchParams.get('run')).toBe('run-2');
    expect(document.querySelector('img,script')).toBeNull();
    expect(document.body.textContent).toContain(unsafe);
    expect(document.body.textContent).toContain('<script>bad()</script>');
  });
});

describe('agent question interactions', () => {
  it('shows fetched questions even when optional contacts fail to load', async () => {
    vi.mocked(client.fetchTrustedContacts).mockRejectedValue(new Error('Contacts unavailable'));
    const { container } = mount();
    await vi.waitFor(() => expect(container.querySelector('form[data-answer="question-1"]')).not.toBeNull());
    expect(container.textContent).toContain(question().question);
    expect(client.fetchClarifications).toHaveBeenCalledWith('org/app');
  });

  it('disables a pending answer submission and preserves the draft beside an inline error', async () => {
    const submission = deferred<Clarification>();
    vi.mocked(client.answerClarification).mockReturnValue(submission.promise);
    const { container } = mount();
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
    const value = 'Keep the existing API until the clients migrate.';
    draft(container, value);
    answerForm(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(client.answerClarification).toHaveBeenCalledWith('question-1', 'org/app', value));
    expect(answerForm(container).querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    submission.reject(new Error('Could not save this answer'));
    await vi.waitFor(() => expect(answerForm(container).closest('.clarification-card')?.textContent).toContain('Could not save this answer'));
    expect(answerForm(container).querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value).toBe(value);
    expect(answerForm(container).querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(client.createClarification).not.toHaveBeenCalled();
  });

  it('submits an answer without contacts and moves the resolved question into history', async () => {
    const answered = question({ state: 'answered', answer: 'Yes, preserve compatibility.' });
    vi.mocked(client.answerClarification).mockImplementation(async () => {
      vi.mocked(client.fetchClarifications).mockResolvedValue([answered]);
      return answered;
    });
    const { container } = mount();
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
    draft(container, answered.answer!);
    answerForm(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).toBeNull());
    expect(client.answerClarification).toHaveBeenCalledWith(answered.id, 'org/app', answered.answer);
    expect(container.querySelector('.clarification-card')?.textContent).toContain(answered.answer);
    expect(container.querySelector('.clarification-card')?.closest('details')?.open).toBe(false);
    expect(client.saveTrustedContact).not.toHaveBeenCalled();
  });

  it('preserves pending drafts across refreshed question lists', async () => {
    const { container, controller } = mount();
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
    draft(container, 'A draft that is not ready to send.');
    vi.mocked(client.fetchClarifications).mockResolvedValue([question(), question({ id: 'question-2', question: 'Another decision' })]);
    await controller.refresh();
    expect(answerForm(container).querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value).toBe('A draft that is not ready to send.');
    expect(container.textContent).toContain('Another decision');
    expect(client.answerClarification).not.toHaveBeenCalled();
  });

  it('shows the current scope while a previous scope answer is still submitting', async () => {
    const submission = deferred<Clarification>();
    const currentSubmission = deferred<Clarification>();
    vi.mocked(client.answerClarification).mockReturnValueOnce(submission.promise).mockReturnValueOnce(currentSubmission.promise);
    let repo = 'org/app';
    const { container, controller } = mount(() => repo);
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
    draft(container, 'Answer for the previous repository.');
    answerForm(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    repo = 'org/other';
    const current = question({ id: 'new-question', repo, question: 'Current scoped question' });
    vi.mocked(client.fetchClarifications).mockResolvedValue([current]);
    await controller.refresh();
    expect(container.textContent).toContain(current.question);
    draft(container, 'Current scope draft', current.id);
    answerForm(container, current.id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(client.answerClarification).toHaveBeenLastCalledWith(current.id, repo, 'Current scope draft');
    submission.resolve(question({ state: 'answered', answer: 'Answer for the previous repository.' }));
    await flushResponses();
    expect(container.textContent).toContain(current.question);
    expect(answerForm(container, current.id).querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value).toBe('Current scope draft');
    expect(answerForm(container, current.id).querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Answer sent to the agent.');
    currentSubmission.reject(new Error('Current answer failed'));
    await vi.waitFor(() => expect(answerForm(container, current.id).textContent).toContain('Current answer failed'));
    expect(answerForm(container, current.id).querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });

  it.each(['success', 'failure'] as const)('discards a stale scope fetch %s', async result => {
    const stale = deferred<Clarification[]>();
    const current = question({ id: 'new-question', repo: 'org/other', question: 'Current scoped question' });
    vi.mocked(client.fetchClarifications).mockReturnValueOnce(stale.promise).mockResolvedValue([current]);
    let repo = 'org/app';
    const { container, controller } = mount(() => repo);
    repo = 'org/other';
    await controller.refresh();
    draft(container, 'Current scope draft', current.id);
    if (result === 'success') stale.resolve([question({ question: 'Stale scope question' })]);
    else stale.reject(new Error('Stale scope failure'));
    await flushResponses();
    expect(container.textContent).toContain(current.question);
    expect(container.textContent).not.toContain('Stale scope question');
    expect(container.textContent).not.toContain('Stale scope failure');
    expect(answerForm(container, current.id).querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value).toBe('Current scope draft');
  });

  it('keeps a revisited scope usable when its previous answer submission fails', async () => {
    const submission = deferred<Clarification>();
    vi.mocked(client.answerClarification).mockReturnValueOnce(submission.promise);
    let repo = 'org/app';
    const { container, controller } = mount(() => repo);
    await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
    draft(container, 'Previous visit answer');
    answerForm(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    repo = 'org/other';
    vi.mocked(client.fetchClarifications).mockResolvedValue([question({ id: 'other-question', repo })]);
    await controller.refresh();
    repo = 'org/app';
    vi.mocked(client.fetchClarifications).mockResolvedValue([question()]);
    await controller.refresh();
    expect(container.querySelector('form[data-answer="question-1"]')).not.toBeNull();
    draft(container, 'New draft after returning');
    submission.reject(new Error('Previous visit failure'));
    await flushResponses();
    expect(container.textContent).not.toContain('Loading questions');
    expect(container.textContent).not.toContain('Previous visit failure');
    expect(answerForm(container).querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value).toBe('New draft after returning');
    expect(answerForm(container).querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });

  it('discards responses arriving after unmount', async () => {
    const pending = deferred<Clarification[]>();
    vi.mocked(client.fetchClarifications).mockReturnValue(pending.promise);
    const { container, controller } = mount();
    controller.destroy();
    container.innerHTML = '<p>New page</p>';
    pending.resolve([question()]);
    await flushResponses();
    expect(container.innerHTML).toBe('<p>New page</p>');
  });
});
