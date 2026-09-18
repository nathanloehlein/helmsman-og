import type { RunSummary } from './data/agents';
import { escapeHtml as esc } from './logic/html';
import { renderAppShell, renderPrPanel, renderVoyage, type PrViewState } from './render';
import './runs.css';

interface RunsViewOpts {
  repos: string[];
  selectedRepo: string | null;
  themeId: string;
  runs: RunSummary[];
}

function paneHref(pane: string, repo: string | null, pr?: number | null): string {
  const params = new URLSearchParams({ pane });
  if (repo) params.set('repo', repo);
  if (Number.isSafeInteger(pr) && (pr ?? 0) > 0) params.set('pr', String(pr));
  return `/runs?${params}`;
}

export function renderRunsView(state: PrViewState, opts: RunsViewOpts): string {
  const repos = opts.repos ?? [];
  const runs = (Array.isArray(opts.runs) ? opts.runs : [])
    .filter((run) => run && typeof run.id === 'string' && run.id && typeof run.repo === 'string'
      && (!opts.selectedRepo || run.repo === opts.selectedRepo))
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const value = state.repo && state.number ? `${state.repo}#${state.number}` : '';
  const panel = state.loading
    ? '<div class="pr-panel empty-note">Loading PR…</div>'
    : state.number
      ? renderPrPanel(state.pr, Boolean(state.pr && repos.includes(state.pr.repo)), true)
      : '<div class="pr-panel empty-note">Load a PR to launch a code review or address feedback with the crew.</div>';
  return renderAppShell({ active: 'runs', repos, selectedRepo: opts.selectedRepo, themeId: opts.themeId, readout: { running: runs.filter(run => run.status === 'running').length, queued: null, review: null } }, `
    <section class="panel pr-lookup-panel" data-pane="newrun">
      <div class="panel-head">
        <span class="panel-title">Run a PR</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('newrun', state.repo ?? opts.selectedRepo, state.number))}" aria-label="Link to Run a PR">Link ↗</a>
      </div>
      <div class="pr-lookup-form">
        <input class="pr-lookup-input" aria-label="PR to run" placeholder="Paste a PR URL or owner/repo#number" value="${esc(value)}" />
        <button class="pr-lookup-go" type="button">Load PR</button>
      </div>
      <div class="pr-lookup-result">${panel}</div>
    </section>
    <section class="panel runs-recent-panel" data-pane="recent">
      <div class="panel-head">
        <span class="panel-title">Recent voyages</span>
        <span class="panel-count mono">${runs.length}</span>
        <a class="app-link runs-pane-link" href="${esc(paneHref('recent', opts.selectedRepo))}" aria-label="Link to Recent voyages">Link ↗</a>
      </div>
      <ul class="recent-runs-list lane-list">${runs.length ? runs.map(renderVoyage).join('') : '<li class="empty-note">No voyages yet.</li>'}</ul>
    </section>
    <div class="runs-drawer-slot" data-pane="tasks"></div>
`);
}
