import type { RunSummary } from './data/agents';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import { term } from './logic/terminology';
import { renderAppShell, renderPrPanel, renderVoyage, type PrViewState } from './render';
import './runs.css';

interface RunsViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  runs: RunSummary[];
  history?: RunHistoryState;
}

export interface RunHistoryState {
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
  error: string | null;
}

function paneHref(pane: string, repo: string | null, pr?: number | null, prRepo?: string | null): string {
  return routeHref({ view: 'runs', pane, repo, pr, prRepo });
}

export function renderRunHistory(runs: RunSummary[], selectedRepo: string | null, history: RunHistoryState): string {
  const visible = (Array.isArray(runs) ? runs : []).filter(run => run && typeof run.id === 'string' && run.id
    && typeof run.repo === 'string' && (!selectedRepo || run.repo === selectedRepo))
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const range = visible.length ? `${history.offset + 1}–${Math.min(history.offset + visible.length, history.total)} of ${history.total}` : `0 of ${history.total}`;
  const unavailable = history.loading || Boolean(history.error);
  const content = history.error
    ? `<li class="empty-note runs-history-error" role="alert">${esc(history.error)} <button type="button" data-runs-retry${history.loading ? ' disabled' : ''}>Try again</button></li>`
    : visible.length ? visible.map(run => renderVoyage(run, undefined, selectedRepo)).join('')
      : `<li class="empty-note">${history.loading ? `Loading ${term('runs').toLowerCase()}…` : term('noRuns')}</li>`;
  return `<section class="panel runs-recent-panel" data-pane="recent" aria-busy="${history.loading}">
      <div class="panel-head">
        <span class="panel-title">${term('allRuns')}</span>
        <span class="panel-count mono">${history.total}</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('recent', selectedRepo))}" aria-label="Link to ${term('allRuns')}">Section link</a>
      </div>
      <ul class="recent-runs-list lane-list">${content}</ul>
      <nav class="runs-pagination" aria-label="${term('runs')} pages" tabindex="-1">
        <span class="runs-page-range mono" role="status">${history.loading ? 'Loading…' : history.error ? 'History unavailable' : range}</span>
        <button type="button" data-runs-page="previous"${unavailable || history.offset <= 0 ? ' disabled' : ''}>Previous</button>
        <button type="button" data-runs-page="next"${unavailable || history.offset + history.limit >= history.total ? ' disabled' : ''}>Next</button>
      </nav>
    </section>`;
}

export function renderRunsView(state: PrViewState, opts: RunsViewOpts): string {
  const repos = opts.repos ?? [];
  const runs = (Array.isArray(opts.runs) ? opts.runs : [])
    .filter((run) => run && typeof run.id === 'string' && run.id && typeof run.repo === 'string'
      && (!opts.selectedRepo || run.repo === opts.selectedRepo))
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const value = state.repo && state.number ? `${state.repo}#${state.number}` : '';
  const panel = state.loading
    ? `<div class="pr-panel empty-note">${term('loadingPr')}</div>`
    : state.number
      ? renderPrPanel(state.pr, Boolean(state.pr && repos.includes(state.pr.repo)), true, opts.selectedRepo)
      : `<div class="pr-panel empty-note">Load a ${term('pr')} for a code ${term('review').toLowerCase()} or to address feedback with the ${term('crew').toLowerCase()}.</div>`;
  return renderAppShell({ active: 'runs', repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: { running: runs.filter(run => run.status === 'running').length, queued: null, review: null } }, `
    <div class="runs-intro"><h1>${term('runs')}</h1><p>Open a ${term('run').toLowerCase()} to follow its progress and logs, or load a ${term('pr')} to review code and address feedback.</p></div>
    <section class="panel pr-lookup-panel" data-pane="newrun">
      <div class="panel-head">
        <span class="panel-title">${term('runPr')}</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('newrun', opts.selectedRepo, state.number, state.repo))}" aria-label="Link to ${term('runPr')}">Section link</a>
      </div>
      <p class="runs-lookup-help">Loading a ${term('pr')} shows its details and available actions. It does not start an agent.</p>
      <label class="runs-lookup-label" for="runs-pr-lookup">${term('pr')} URL or owner/repo#number</label>
      <div class="pr-lookup-form">
        <input id="runs-pr-lookup" class="pr-lookup-input" placeholder="${term('prPlaceholder')}" value="${esc(value)}" />
        <button class="pr-lookup-go" type="button">Load ${term('pr')}</button>
      </div>
      <div class="pr-lookup-result">${panel}</div>
    </section>
    ${renderRunHistory(runs, opts.selectedRepo, opts.history ?? { total: runs.length, offset: 0, limit: 25, loading: false, error: null })}
    <div class="runs-drawer-slot" data-pane="tasks"></div>
`);
}
