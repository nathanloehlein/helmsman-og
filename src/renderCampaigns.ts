import type { CampaignDetail, CampaignList, CampaignPreview } from './data/campaigns';
import { actOnCampaignPhase, confirmCampaignImport, createCampaign, createCampaignPhase, fetchCampaign, fetchCampaigns, previewCampaignImport, retryCampaignTask } from './data/campaignClient';
import { escapeHtml as esc } from './logic/html';
import { term } from './logic/terminology';
import './campaigns.css';

export interface CampaignsViewState {
  repo: string | null;
  list: CampaignList;
  detail: CampaignDetail | null;
  preview: CampaignPreview | null;
  busy: boolean;
  error: string | null;
  name: string;
  phaseName: string;
  concurrency: string;
  workflowRef: string;
  imports: Record<string, { format: string; content: string }>;
  confirming: { phaseId: string; action: 'finish' | 'stop' } | null;
}

const label = (value: string): string => value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase());
export function renderCampaigns(state: CampaignsViewState): string {
  const selected = state.detail?.campaign;
  const disabled = state.busy ? ' disabled' : '';
  const preview = state.preview;
  const list = state.list?.campaigns ?? [];
  const workflows = state.list?.workflows ?? [];
  return `<div class="campaign-page"><h1>Campaigns</h1><p>Preview a batch of tasks, then run it in ordered phases. Each ${term('repository').toLowerCase()} has one active writer.</p>
    ${state.error ? `<p class="campaign-error" role="alert">${esc(state.error)}</p>` : ''}
    ${state.busy ? '<p role="status">Updating campaigns…</p>' : ''}
    <div class="campaign-layout"><section class="panel campaign-panel"><h2>New campaign</h2>
      ${!state.repo ? `<p>Select a ${term('repository').toLowerCase()} in the header to create a campaign.</p>` : `<p>${esc(state.repo)}</p>`}
      <form data-campaign-create><fieldset${state.busy || !state.repo || !workflows.length ? ' disabled' : ''}>
        <label>Name<input name="name" required maxlength="120" value="${esc(state.name)}"></label>
        <label>Workflow<select name="workflowRef">${workflows.map(workflow => `<option value="${esc(workflow.ref)}"${workflow.ref === state.workflowRef ? ' selected' : ''}>${esc(workflow.name)} · ${esc(workflow.ref)}</option>`).join('')}</select></label>
        <label>Concurrent tasks<input name="concurrency" type="number" min="1" max="20" required value="${esc(state.concurrency)}"></label>
        <button type="submit">Create campaign</button></fieldset></form>
      <h2>Saved campaigns</h2><button type="button" data-campaign-refresh${disabled}>Refresh</button>
      <ul class="campaign-list">${list.map(campaign => `<li><button type="button" data-campaign-select="${esc(campaign.id)}" aria-pressed="${campaign.id === selected?.id}"${disabled}>${esc(campaign.name)}</button><small>${esc(campaign.repo)}</small></li>`).join('') || '<li>No campaigns in this scope.</li>'}</ul></section>
      <section class="campaign-detail" aria-busy="${state.busy}">${selected ? `<h2>${esc(selected.name)}</h2><p>${esc(selected.workflowRef)} · up to ${selected.concurrency} active tasks</p>
      <form data-campaign-phase-create="${esc(selected.id)}"><fieldset${disabled}><label>New phase<input name="phaseName" required maxlength="120" value="${esc(state.phaseName)}" placeholder="Canary, then broader rollout"></label><button type="submit">Add phase</button></fieldset></form>
      ${(state.detail?.phases ?? []).map(({ phase, tasks }) => {
        const editable = phase.state === 'draft' || phase.state === 'paused';
        const draft = state.imports[phase.id] ?? { format: 'jsonl', content: '' };
        const controls = phase.state === 'draft' ? ['start', 'finish', 'stop'] : phase.state === 'running' ? ['pause', 'finish', 'stop'] : phase.state === 'paused' ? ['resume', 'finish', 'stop'] : [];
        return `<section class="panel campaign-panel"><h3>${phase.position + 1}. ${esc(phase.name)} <span class="campaign-state">${esc(label(phase.state))}</span></h3>
          <div class="campaign-actions">${controls.map(action => `<button type="button" data-campaign-action="${action}" data-phase-id="${esc(phase.id)}"${state.busy || action === 'start' && !tasks.length ? ' disabled' : ''}>${label(action)}</button>`).join('')}</div>
          ${state.confirming?.phaseId === phase.id ? `<div class="campaign-confirm" role="status"><p>${state.confirming.action === 'stop' ? 'Stop active tasks and cancel all queued tasks in this phase.' : 'Cancel queued tasks and let active tasks finish.'}</p><button type="button" data-campaign-confirm-action${disabled}>Confirm ${state.confirming.action}</button><button type="button" data-campaign-dismiss${disabled}>Keep phase</button></div>` : ''}
          ${editable ? `<form data-campaign-import="${esc(phase.id)}"><fieldset${disabled}><label>Import format<select name="format" data-phase-id="${esc(phase.id)}"><option value="jsonl"${draft.format === 'jsonl' ? ' selected' : ''}>JSONL</option><option value="csv"${draft.format === 'csv' ? ' selected' : ''}>CSV</option></select></label>
            <label>Upload a file<input type="file" accept=".csv,.jsonl,.ndjson,text/csv,application/json" data-campaign-file="${esc(phase.id)}"></label>
            <label>Tasks<textarea name="content" data-phase-id="${esc(phase.id)}" rows="5" required maxlength="1000000" placeholder='{"task":"Describe one concrete task"}'>${esc(draft.content)}</textarea></label>
            <p class="campaign-hint">Up to 200 records / 1 MB. Fields: task or ticketId, optional key, title, repo. Explicit repo values override the header scope and appear in the preview.</p><button type="submit">Preview import</button></fieldset></form>` : ''}
          ${preview?.phaseId === phase.id ? `<div class="campaign-preview"><h4>Review imported tasks</h4><p>${preview.records.length} unique records · ${preview.duplicateCount} duplicates will be skipped.</p><ol>${preview.records.map(record => `<li><strong>${esc(record.repo)}</strong> · ${esc(record.task ?? record.ticketId ?? '')}</li>`).join('')}</ol><p>Confirming queues these tasks. Start or resume the phase to launch them.</p><button type="button" data-campaign-confirm-import="${esc(preview.id)}"${disabled}>Confirm import</button><button type="button" data-campaign-dismiss-preview${disabled}>Discard preview</button></div>` : ''}
          <div class="campaign-table-wrap"><table><thead><tr><th>Task</th><th>${term('repository')}</th><th>State</th><th>Attempt</th><th>Action</th></tr></thead><tbody>${tasks.map(task => `<tr><td>${esc(task.record.title ?? task.record.ticketId ?? task.record.task ?? '')}${task.error ? `<small class="campaign-error">${esc(task.error)}</small>` : ''}</td><td>${esc(task.record.repo)}</td><td>${esc(label(task.state))}</td><td>${task.attempt}</td><td>${['running', 'succeeded', 'failed'].includes(task.state) ? `<button type="button" data-campaign-open-run="${esc(task.runId)}">Open ${term('run').toLowerCase()}</button>` : ''}${task.state === 'failed' && !['finished', 'stopped'].includes(phase.state) ? `<button type="button" data-campaign-retry="${esc(task.id)}"${disabled}>Retry failed task</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No tasks imported yet.</td></tr>'}</tbody></table></div></section>`;
      }).join('') || '<p>Add a phase to import tasks.</p>'}` : '<p>Select a campaign to manage its phases.</p>'}</section></div></div>`;
}

export function mountCampaigns(container: HTMLElement, options: { repo(): string | null; onOpenRun?(id: string): void }): { refresh(): Promise<void>; destroy(): void } {
  const state: CampaignsViewState = { repo: options.repo(), list: { campaigns: [], workflows: [] }, detail: null, preview: null,
    busy: false, error: null, name: '', phaseName: '', concurrency: '1', workflowRef: '', imports: {}, confirming: null };
  let destroyed = false;
  let generation = 0;
  let selectedId: string | null = null;
  const render = () => { if (!destroyed) container.innerHTML = renderCampaigns(state); };
  async function refresh(): Promise<void> {
    const token = ++generation;
    const scope = options.repo();
    if (scope !== state.repo) {
      state.repo = scope; state.detail = null; state.preview = null; state.imports = {}; state.confirming = null; selectedId = null;
      state.list = { campaigns: [], workflows: [] }; render();
    }
    try {
      const list = await fetchCampaigns(scope);
      if (destroyed || token !== generation || scope !== options.repo()) return;
      state.list = list;
      if (!list.workflows.some(workflow => workflow.ref === state.workflowRef)) state.workflowRef = list.workflows[0]?.ref ?? '';
      selectedId = list.campaigns.some(campaign => campaign.id === selectedId) ? selectedId : list.campaigns[0]?.id ?? null;
      const detail = selectedId ? await fetchCampaign(selectedId, scope) : null;
      if (destroyed || token !== generation || scope !== options.repo()) return;
      state.detail = detail;
      state.error = null;
    } catch (error) { if (!destroyed && token === generation) state.error = error instanceof Error ? error.message : 'Campaigns are unavailable'; }
    if (!destroyed && token === generation) render();
  }
  async function act(work: (scope: string | null) => Promise<void>): Promise<void> {
    if (state.busy || destroyed) return;
    const scope = options.repo(); state.busy = true; state.error = null; render();
    try { await work(scope); if (scope === options.repo()) await refresh(); }
    catch (error) { if (scope === options.repo()) state.error = error instanceof Error ? error.message : 'Campaign action failed'; }
    finally { state.busy = false; render(); }
  }
  const onInput = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    if (input.name === 'name') state.name = input.value;
    if (input.name === 'phaseName') state.phaseName = input.value;
    if (input.name === 'concurrency') state.concurrency = input.value;
    if (input.name === 'workflowRef') state.workflowRef = input.value;
    const phaseId = input.dataset.phaseId;
    if (phaseId && (input.name === 'format' || input.name === 'content')) {
      const draft = state.imports[phaseId] ?? { format: 'jsonl', content: '' };
      state.imports[phaseId] = { ...draft, [input.name]: input.value }; state.preview = null;
      container.querySelector('.campaign-preview')?.remove();
    }
  };
  const onChange = (event: Event) => {
    onInput(event);
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.campaignFile) return;
    const phaseId = input.dataset.campaignFile;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) { state.error = 'Import must be under 1 MB'; render(); return; }
    const scope = options.repo();
    void file.text().then(content => {
      if (destroyed || scope !== options.repo()) return;
      state.imports[phaseId] = { format: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl', content };
      state.preview = null; render();
    }).catch(() => { state.error = 'Unable to read import file'; render(); });
  };
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.hasAttribute('data-campaign-create')) void act(async scope => {
      if (!scope) throw new Error('Select a galleon');
      const campaign = await createCampaign(scope, { name: state.name, workflowRef: state.workflowRef, concurrency: Number(state.concurrency) });
      if (scope === options.repo()) { selectedId = campaign.id; state.name = ''; }
    });
    else if (form.dataset.campaignPhaseCreate) void act(async scope => { await createCampaignPhase(form.dataset.campaignPhaseCreate!, scope, state.phaseName); state.phaseName = ''; });
    else if (form.dataset.campaignImport) {
      const phaseId = form.dataset.campaignImport;
      const draft = state.imports[phaseId] ?? { format: 'jsonl', content: '' };
      void act(async scope => { const preview = await previewCampaignImport(phaseId, scope, draft.format, draft.content); if (scope === options.repo()) state.preview = preview; });
    }
  };
  const onClick = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-campaign-refresh')) { void refresh(); return; }
    if (button.dataset.campaignSelect) { selectedId = button.dataset.campaignSelect; state.preview = null; state.confirming = null; void refresh(); return; }
    if (button.dataset.campaignOpenRun) { options.onOpenRun?.(button.dataset.campaignOpenRun); return; }
    if (button.hasAttribute('data-campaign-dismiss')) { state.confirming = null; render(); return; }
    if (button.hasAttribute('data-campaign-dismiss-preview')) { state.preview = null; render(); return; }
    const action = button.dataset.campaignAction;
    const phaseId = button.dataset.phaseId;
    if ((action === 'stop' || action === 'finish') && phaseId) { state.confirming = { phaseId, action }; render(); return; }
    if (action && phaseId) void act(scope => actOnCampaignPhase(phaseId, scope, action));
    else if (button.hasAttribute('data-campaign-confirm-action') && state.confirming) {
      const pending = state.confirming;
      void act(async scope => { await actOnCampaignPhase(pending.phaseId, scope, pending.action); state.confirming = null; });
    } else if (button.dataset.campaignConfirmImport) {
      const id = button.dataset.campaignConfirmImport;
      void act(async scope => { await confirmCampaignImport(id, scope); state.preview = null; });
    } else if (button.dataset.campaignRetry) {
      const id = button.dataset.campaignRetry; void act(scope => retryCampaignTask(id, scope));
    }
  };
  container.addEventListener('input', onInput); container.addEventListener('change', onChange);
  container.addEventListener('submit', onSubmit); container.addEventListener('click', onClick);
  const timer = setInterval(() => {
    if (!document.hidden && !state.busy && !container.contains(document.activeElement)) void refresh();
  }, 30_000);
  render(); void refresh();
  return { refresh, destroy() { destroyed = true; generation++; clearInterval(timer);
    container.removeEventListener('input', onInput); container.removeEventListener('change', onChange);
    container.removeEventListener('submit', onSubmit); container.removeEventListener('click', onClick); } };
}
