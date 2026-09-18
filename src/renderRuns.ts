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
}

function paneHref(pane: string, repo: string | null, pr?: number | null, prRepo?: string | null): string {
  return routeHref({ view: 'runs', pane, repo, pr, prRepo });
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
    <section class="panel pr-lookup-panel" data-pane="newrun">
      <div class="panel-head">
        <span class="panel-title">${term('runPr')}</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('newrun', opts.selectedRepo, state.number, state.repo))}" aria-label="Link to ${term('runPr')}">Link ↗</a>
      </div>
      <div class="pr-lookup-form">
        <input class="pr-lookup-input" aria-label="${term('pr')} to run" placeholder="${term('prPlaceholder')}" value="${esc(value)}" />
        <button class="pr-lookup-go" type="button">Load ${term('pr')}</button>
      </div>
      <div class="pr-lookup-result">${panel}</div>
    </section>
    <section class="panel runs-recent-panel" data-pane="recent">
      <div class="panel-head">
        <span class="panel-title">${term('recentRuns')}</span>
        <span class="panel-count mono">${runs.length}</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('recent', opts.selectedRepo))}" aria-label="Link to ${term('recentRuns')}">Link ↗</a>
      </div>
      <ul class="recent-runs-list lane-list">${runs.length ? runs.map(run => renderVoyage(run, undefined, opts.selectedRepo)).join('') : `<li class="empty-note">${term('noRuns')}</li>`}</ul>
    </section>
    <div class="runs-drawer-slot" data-pane="tasks"></div>
`);
}
