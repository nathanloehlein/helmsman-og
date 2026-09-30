import { fetchInstructions, sendInstruction, type InstructionState, type RunInstruction } from './data/instructions';
import { escapeHtml as esc } from './logic/html';
import { term } from './logic/terminology';
import './instructions.css';

interface Draft {
  text: string;
  targetId: string;
  state?: InstructionState;
  error?: string;
  pending?: { id: string; targetId: string; text: string };
  sending: boolean;
  version: number;
  expandHistory?: boolean;
}

export function createRunInstructions(): { mount(container: HTMLElement, runId: string | null, complete: boolean): void; destroy(): void } {
  const element = document.createElement('section');
  element.className = 'run-instructions';
  element.setAttribute('aria-label', 'Instructions');
  const drafts = new Map<string, Draft>();
  let currentId: string | null = null;
  let complete = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function current(): Draft | undefined { return currentId ? drafts.get(currentId) : undefined; }

  function paint(): void {
    if (destroyed) return;
    const draft = current();
    if (!draft) { element.innerHTML = ''; return; }
    const active = element.contains(document.activeElement) ? document.activeElement : null;
    const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
    const historyOpen = draft.expandHistory || (element.querySelector('details')?.open ?? false);
    const historyScroll = element.querySelector('ol')?.scrollTop ?? 0;
    const state = draft.state;
    const targets = state?.targets ?? [];
    if (!targets.some(target => target.id === draft.targetId)) draft.targetId = targets[0]?.id ?? '';
    const allowed = !complete && state?.available && targets.length > 0;
    const awaitingReceipt = state?.instructions.some(item => item.targetId === draft.targetId && item.status === 'sending') ?? false;
    const sending = draft.sending || awaitingReceipt;
    const statuses = { sending: 'Sending', delivered: 'Received by agent', failed: 'Failed', unknown: 'Delivery unknown' };
    const latest = state?.instructions.at(-1);
    element.innerHTML = `${!complete ? `<div class="instruction-heading">Send instruction</div>
      ${allowed ? `<form class="instruction-form">
        ${targets.length > 1 ? `<label>Recipient<select name="targetId" ${draft.sending ? 'disabled' : ''}>${targets.map(target => `<option value="${esc(target.id)}" ${target.id === draft.targetId ? 'selected' : ''}>${esc(target.provider)} · ${esc(target.stage)}</option>`).join('')}</select></label>` : ''}
        <label class="instruction-input">Instruction<textarea name="instruction" rows="2" maxlength="8000" required placeholder="Add context or redirect the current task" ${draft.sending ? 'disabled' : ''}>${esc(draft.text)}</textarea></label>
        <button type="submit" ${sending ? 'disabled' : ''}>${sending ? 'Awaiting receipt…' : 'Send instruction'}</button>
      </form><p class="instruction-help">Delivered means the ${term('agent').toLowerCase()} received it, not that the work is complete.</p>`
        : `<p class="instruction-help">${esc(state?.reason ?? (state ? 'No agent is currently accepting instructions.' : 'Checking instruction availability…'))}</p>`}` : ''}
      ${sending ? '<p class="instruction-help" role="status">Waiting for the agent to acknowledge your instruction.</p>' : latest ? `<p class="instruction-help" role="status">Latest instruction: ${statuses[latest.status]}</p>` : ''}
      ${draft.error ? `<p class="instruction-error" role="alert">${esc(draft.error)}</p>` : ''}
      ${state?.instructions.length ? `<details class="instruction-history" ${historyOpen ? 'open' : ''}><summary>Instruction history (${state.instructions.length})</summary><ol>${state.instructions.map(item => `<li data-instruction-id="${esc(item.id)}"><div class="instruction-meta"><strong data-instruction-status="${item.status}">${statuses[item.status]}</strong><span>${esc(item.provider)} · ${esc(item.stage)}</span><time datetime="${esc(item.createdAt)}">${esc(new Date(item.createdAt).toLocaleString())}</time></div><p>${esc(item.text)}</p>${item.error ? `<p class="instruction-error">${esc(item.error)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}`;
    if (state?.instructions.length) draft.expandHistory = false;
    const history = element.querySelector('ol');
    if (history) history.scrollTop = historyScroll;
    if (active instanceof HTMLTextAreaElement) {
      const next = element.querySelector('textarea');
      next?.focus({ preventScroll: true });
      if (selection) next?.setSelectionRange(...selection);
    } else if (active instanceof HTMLSelectElement) element.querySelector('select')?.focus({ preventScroll: true });
    else if (active instanceof HTMLButtonElement) element.querySelector('button')?.focus({ preventScroll: true });
  }

  function schedule(token: number): void {
    if (destroyed || token !== generation) return;
    clearTimeout(timer);
    if (currentId && (!complete || current()?.state?.instructions.some(item => item.status === 'sending'))) {
      timer = setTimeout(() => { void refresh(token); }, 2_000);
    }
  }

  async function refresh(token: number): Promise<void> {
    const id = currentId;
    const draft = current();
    if (!id || !draft || destroyed || token !== generation) return;
    if (draft.sending) { schedule(token); return; }
    const version = draft.version;
    try {
      const state = await fetchInstructions(id);
      if (destroyed || token !== generation || version !== draft.version) return;
      draft.state = state;
      draft.error = undefined;
      const acknowledged = draft.pending && state.instructions.find(item => item.id === draft.pending?.id);
      if (acknowledged && acknowledged.status === 'delivered') {
        if (draft.text.trim() === draft.pending?.text) draft.text = '';
        draft.pending = undefined;
      } else if (acknowledged?.status === 'failed') {
        draft.pending = undefined;
        draft.error = acknowledged.error ?? 'The agent did not receive the instruction.';
      }
      paint();
    } catch (error) {
      if (destroyed || token !== generation || version !== draft.version) return;
      draft.error = error instanceof Error ? error.message : 'Instructions are unavailable.';
      paint();
    } finally { schedule(token); }
  }

  element.addEventListener('input', event => {
    const draft = current();
    if (draft && event.target instanceof HTMLTextAreaElement) draft.text = event.target.value;
  });
  element.addEventListener('change', event => {
    const draft = current();
    if (draft && event.target instanceof HTMLSelectElement) { draft.targetId = event.target.value; paint(); }
  });
  element.addEventListener('submit', event => {
    event.preventDefault();
    const runId = currentId;
    const draft = current();
    if (!runId || !draft || complete || draft.sending || !draft.state?.available
      || draft.state.instructions.some(item => item.targetId === draft.targetId && item.status === 'sending')) return;
    const text = draft.text.trim();
    if (!text || !draft.state.targets.some(target => target.id === draft.targetId)) return;
    const pending = draft.pending?.text === text && draft.pending.targetId === draft.targetId ? draft.pending : { id: crypto.randomUUID(), targetId: draft.targetId, text };
    draft.pending = pending;
    draft.sending = true;
    draft.version++;
    draft.error = undefined;
    draft.expandHistory = true;
    paint();
    void (async () => {
      try {
        const result: RunInstruction = await sendInstruction(runId, pending);
        if (destroyed) return;
        if (draft.state) draft.state.instructions = [...draft.state.instructions.filter(item => item.id !== result.id), result];
        if (result.status === 'delivered') {
          if (draft.text.trim() === text) draft.text = '';
          draft.pending = undefined;
        } else if (result.status === 'failed') {
          draft.pending = undefined;
          draft.error = result.error ?? 'The agent did not receive the instruction.';
        }
      } catch (error) {
        if (destroyed) return;
        draft.error = `${error instanceof Error ? error.message : 'Could not send instruction.'} Delivery is unconfirmed. Retrying the same instruction will not send it twice.`;
      } finally {
        draft.sending = false;
        if (!destroyed && currentId === runId) {
          paint();
          if (complete) void refresh(generation);
          else schedule(generation);
        }
      }
    })();
  });

  return {
    mount(container, runId, ended) {
      if (destroyed) return;
      container.appendChild(element);
      const changed = runId !== currentId || ended !== complete;
      currentId = runId;
      complete = ended;
      if (runId && !drafts.has(runId)) drafts.set(runId, { text: '', targetId: '', sending: false, version: 0 });
      paint();
      if (changed) { clearTimeout(timer); void refresh(++generation); }
    },
    destroy() { destroyed = true; generation++; clearTimeout(timer); element.remove(); drafts.clear(); },
  };
}
