import type { Clarification, TrustedContact } from './data/clarifications';
import { answerClarification, fetchClarifications, fetchTrustedContacts, saveTrustedContact } from './data/clarificationClient';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import { term } from './logic/terminology';
import './clarifications.css';

interface QuestionViewState {
  loading?: boolean;
  contactError?: string | null;
  notice?: string | null;
}

function deadline(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `<span>Answer by <time datetime="${esc(value)}">${esc(date.toLocaleString())}</time></span>`;
}

function questionCard(item: Clarification, contacts: TrustedContact[]): string {
  const pending = item.state === 'pending';
  const owner = contacts.find(contact => contact.id === item.contactId);
  const state = item.state === 'answered' ? 'Answered' : item.state === 'timed-out' ? 'Deadline passed' : item.state === 'cancelled' ? 'Closed' : item.required ? 'Answer required' : 'Optional answer';
  return `<article class="clarification-card" data-question="${esc(item.id)}">
    <div class="clarification-meta"><span class="clarification-state">${state}</span><span>${esc(item.repo)}</span><a class="app-link" href="${esc(routeHref({ view: 'runs', repo: item.repo, run: item.runId }))}">View ${term('run').toLowerCase()} ${esc(item.runId)}</a></div>
    <h3>${esc(item.question)}</h3>
    ${pending ? `<p class="clarification-help">${item.required ? 'The agent needs your answer before it can finish or publish its work.' : 'Answer if you have useful context. This question does not block completion.'}</p>
      <div class="clarification-meta">${deadline(item.timeoutAt)}${owner ? `<span>Suggested respondent: ${esc(owner.name)}</span>` : ''}</div>
      <form data-answer="${esc(item.id)}"><label>Your answer<textarea name="answer" required maxlength="4000" rows="3"></textarea></label><div class="clarification-actions"><button type="submit">Send answer</button><span class="clarification-form-error" role="alert"></span></div></form>`
      : `${item.answer ? `<p class="clarification-answer"><strong>Your answer</strong>${esc(item.answer)}</p>` : `<p class="clarification-help">${item.state === 'timed-out' ? 'The deadline passed without an answer. Open the run to check its status.' : 'This question is closed and no longer accepts answers.'}</p>`}`}
  </article>`;
}

export function renderClarifications(items: Clarification[], contacts: TrustedContact[], repo: string | null, error: string | null, state: QuestionViewState = {}): string {
  const pending = items.filter(item => item.state === 'pending');
  const history = items.filter(item => item.state !== 'pending');
  return `<div class="clarification-page">
    <header class="clarification-heading"><div><h1>${term('clarifications')}</h1><p>When an agent needs a decision from you, its question appears here. Your answer goes back to that agent.</p></div><button type="button" data-refresh-questions>Refresh questions</button></header>
    <p class="clarification-help">This page is for answering agents. To give an agent a new task, <a class="app-link" href="${esc(routeHref({ view: 'runs', repo, pane: 'newrun' }))}">start a ${term('run').toLowerCase()}</a>.</p>
    ${state.notice ? `<p role="status" class="clarification-notice">${esc(state.notice)}</p>` : ''}
    ${error ? `<p role="alert" class="clarification-error">Could not refresh questions. ${esc(error)} Use “Refresh questions” to try again.</p>` : ''}
    <section class="clarification-list" aria-labelledby="pending-questions"><div class="clarification-section-heading"><h2 id="pending-questions">Questions awaiting your answer${pending.length ? ` (${pending.length})` : ''}</h2><span class="clarification-meta">${esc(repo ?? term('allRepositories'))}</span></div>
      ${pending.map(item => questionCard(item, contacts)).join('') || (state.loading ? '<p role="status">Loading questions…</p>' : error ? '<p class="clarification-help">Questions could not be loaded.</p>' : '<div class="clarification-empty"><h3>No questions need your answer</h3><p>Questions from agents in this scope will appear here. No contact setup is needed.</p></div>')}
    </section>
    ${history.length ? `<details class="clarification-history"><summary>Answered and closed questions (${history.length})</summary>${history.map(item => questionCard(item, contacts)).join('')}</details>` : ''}
    <details class="clarification-settings" data-contact-settings><summary>Optional contact settings</summary><h2>Suggested respondents</h2><p>You can answer questions without adding contacts. These entries help assign a question to a person, such as the Jira assignee or reporter. Helmsman does not message or notify them.</p>
      ${state.contactError ? `<p role="alert" class="clarification-error">Contacts could not be loaded. You can still answer questions. ${esc(state.contactError)}</p>` : ''}
      <form class="trusted-contact-form"><label>Name<input name="name" required maxlength="160" autocomplete="name"></label><label>Jira account ID or address<input name="address" required maxlength="320"><span class="clarification-help">Use a Jira account ID to match an assignee or reporter automatically.</span></label><label><input name="enabled" type="checkbox" checked> Available as a suggested respondent</label><div class="clarification-actions"><button type="submit">Save contact</button><span class="clarification-form-error" role="alert"></span></div></form>
      <ul class="clarification-contacts">${contacts.map(contact => `<li><strong>${esc(contact.name)}</strong> · ${esc(contact.address)} · ${contact.enabled ? 'available' : 'disabled'}</li>`).join('') || '<li>No contacts added. You can answer questions yourself.</li>'}</ul>
    </details>
  </div>`;
}

export function mountClarifications(container: HTMLElement, options: { repo(): string | null }): { refresh(): Promise<void>; destroy(): void } {
  let items: Clarification[] = [];
  let contacts: TrustedContact[] = [];
  let error: string | null = null;
  let contactError: string | null = null;
  let notice: string | null = null;
  let loading = true;
  let destroyed = false;
  let sequence = 0;
  let scope = options.repo();
  let submission: { repo: string | null } | null = null;

  function paint(): void {
    if (destroyed) return;
    const fields = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
    const values = fields.map(field => ({ key: field.closest('form')?.getAttribute('data-answer') ?? 'contact', name: field.name, value: field.value, checked: field instanceof HTMLInputElement && field.checked }));
    const openDetails = new Map([...container.querySelectorAll('details')].map(details => [details.className, details.open]));
    const active = document.activeElement;
    const focused = fields.findIndex(field => field === active);
    const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
    container.innerHTML = renderClarifications(items, contacts, scope, error, { loading, contactError, notice });
    const nextFields = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
    for (const field of nextFields) {
      const previous = values.find(value => value.key === (field.closest('form')?.getAttribute('data-answer') ?? 'contact') && value.name === field.name);
      if (!previous) continue;
      field.value = previous.value;
      if (field instanceof HTMLInputElement) field.checked = previous.checked;
      if (previous === values[focused]) { field.focus(); if (field instanceof HTMLTextAreaElement && selection) field.setSelectionRange(...selection); }
    }
    container.querySelectorAll('details').forEach(details => { details.open = openDetails.get(details.className) ?? false; });
  }

  async function refresh(): Promise<void> {
    const token = ++sequence;
    const repo = options.repo();
    if (repo !== scope) { scope = repo; items = []; notice = null; error = null; container.innerHTML = ''; loading = true; paint(); }
    const [questions, people] = await Promise.allSettled([fetchClarifications(repo), fetchTrustedContacts()]);
    if (destroyed || token !== sequence || repo !== options.repo()) return;
    if (questions.status === 'fulfilled') { items = questions.value; error = null; }
    else error = questions.reason instanceof Error ? questions.reason.message : 'The server is unavailable.';
    if (people.status === 'fulfilled') { contacts = people.value; contactError = null; }
    else contactError = people.reason instanceof Error ? people.reason.message : 'Try refreshing questions.';
    loading = false;
    if (!submission || submission.repo !== scope) paint();
  }

  const submit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (submission && submission.repo === scope) return;
    const repo = scope;
    const data = new FormData(form);
    const id = form.dataset.answer;
    const answer = String(data.get('answer') ?? '').trim();
    const feedback = form.querySelector<HTMLElement>('.clarification-form-error');
    if (id && !answer) { if (feedback) feedback.textContent = 'Enter an answer before sending.'; return; }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const pendingSubmission = { repo };
    submission = pendingSubmission;
    notice = null;
    if (feedback) feedback.textContent = '';
    if (button) { button.disabled = true; button.textContent = id ? 'Sending answer…' : 'Saving contact…'; }
    void (async () => {
      try {
        if (id) await answerClarification(id, repo, answer);
        else if (form.matches('.trusted-contact-form')) await saveTrustedContact({ name: String(data.get('name') ?? ''), address: String(data.get('address') ?? ''), enabled: data.get('enabled') === 'on' });
        else return;
        if (destroyed || repo !== options.repo()) return;
        form.reset();
        notice = id ? 'Answer sent to the agent.' : 'Contact saved. No notification was sent.';
        if (id) items = items.map(item => item.id === id ? { ...item, state: 'answered', answer } : item);
        await refresh();
      } catch (reason) {
        if (!destroyed && repo === options.repo() && feedback) feedback.textContent = `Could not ${id ? 'send answer' : 'save contact'}. ${reason instanceof Error ? reason.message : 'Try again.'}`;
      } finally {
        if (submission === pendingSubmission) submission = null;
        if (button) { button.disabled = false; button.textContent = id ? 'Send answer' : 'Save contact'; }
        if (!destroyed && repo === options.repo() && notice) paint();
      }
    })();
  };
  const click = (event: Event) => { if (event.target instanceof Element && event.target.closest('[data-refresh-questions]')) void refresh(); };
  container.addEventListener('submit', submit);
  container.addEventListener('click', click);
  paint(); void refresh();
  return { refresh, destroy() { destroyed = true; sequence++; container.removeEventListener('submit', submit); container.removeEventListener('click', click); } };
}
