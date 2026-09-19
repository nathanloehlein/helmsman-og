import { escapeHtml as esc } from './logic/html';
import { term } from './logic/terminology';
import { routeHref } from './logic/routes';
import type { OutcomeRun, OutcomeSummary } from './data/outcomes';
import type { OutcomeWindow } from './data/outcomeClient';
import { renderAppShell, type HelmHeadOpts } from './render';

export interface OutcomesViewState { summary: OutcomeSummary | null; days: OutcomeWindow; loading: boolean; error: string | null; savingRunId: string | null; }

const money = (value: number | null): string => typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : 'Unknown';
const count = (value: number | null): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Unknown';
const dateLabel = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const duration = (value: number | null): string => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 60000)} min` : 'Unknown';

function stat(label: string, value: string, detail = ''): string { return `<div class="outcome-stat"><span>${esc(label)}</span><b>${esc(value)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`; }

function assessmentForm(run: OutcomeRun, saving: boolean): string {
  const assessment = run.assessment;
  return `<details class="outcome-assessment"><summary>${assessment ? 'Edit task assessment' : 'Assess task outcome'}</summary><form data-outcome-assessment="${esc(run.runId)}">
    <p class="outcome-help">Record whether the task met its goal. A successful process exit alone does not prove the work is complete.</p><label>Assessment progress <select name="state"><option value="not-assessed"${assessment?.state === 'not-assessed' ? ' selected' : ''}>Not assessed</option><option value="complete"${assessment?.state === 'complete' ? ' selected' : ''}>Complete</option><option value="partial"${assessment?.state === 'partial' ? ' selected' : ''}>Partial</option><option value="failed"${assessment?.state === 'failed' ? ' selected' : ''}>Unable to assess</option></select><small>Use Complete or Partial when you have evidence. Not assessed and Unable to assess require an Unknown outcome.</small></label>
    <label>Task outcome <select name="outcome"><option value="unknown"${assessment?.outcome === 'unknown' ? ' selected' : ''}>Unknown</option><option value="achieved"${assessment?.outcome === 'achieved' ? ' selected' : ''}>Achieved</option><option value="partial"${assessment?.outcome === 'partial' ? ' selected' : ''}>Partial</option><option value="not-achieved"${assessment?.outcome === 'not-achieved' ? ' selected' : ''}>Not achieved</option></select></label>
    <label>Summary (required) <textarea name="summary" required maxlength="4000" placeholder="What was achieved, and what is still missing?">${esc(assessment?.summary ?? '')}</textarea></label>
    <label>Evidence <textarea name="evidence" placeholder="One URL, PR, test result, or note per line">${esc((assessment?.evidence ?? []).join('\n'))}</textarea><small>Required for any outcome other than Unknown. Up to 30 references.</small></label>
    <details class="outcome-assessment-details"><summary>Failure and correction details (optional)</summary><div><label>Where the task failed <input name="failureStage" maxlength="120" placeholder="For example, tests or review" value="${esc(assessment?.failureStage ?? '')}"></label><label>Correction rounds <input name="correctionRounds" type="number" min="0" max="100" step="1" value="${assessment?.correctionRounds ?? ''}"></label></div></details>
    <button type="submit"${saving ? ' disabled aria-busy="true"' : ''}>${saving ? 'Saving…' : 'Save assessment'}</button><span class="outcome-save-error" role="alert"></span>
  </form></details>`;
}

export function renderOutcomesView(state: OutcomesViewState, opts: HelmHeadOpts): string {
  const summary = state.summary;
  const intro = `<div class="outcomes-intro"><h1>${term('costsOutcomes')}</h1><p>Compare reported agent usage with delivered work. Review a ${term('run').toLowerCase()} below to record whether its task achieved the intended result.</p></div>`;
  const select = [7, 30, 90, 365].map(days => `<option value="${days}"${state.days === days ? ' selected' : ''}>Last ${days} days</option>`).join('');
  if (state.loading && !summary) return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view">${intro}<div class="outcome-toolbar"><label>Time period <select data-outcome-days>${select}</select></label></div><div class="empty-note" role="status">Loading ${term('costsOutcomes').toLowerCase()}…</div></section>`);
  if (state.error && !summary) return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view">${intro}<div class="outcome-toolbar"><label>Time period <select data-outcome-days>${select}</select></label></div><div class="degraded-banner" role="alert">${esc(state.error)} Reload this page or choose a different time period to try again.</div></section>`);
  if (!summary) return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view">${intro}<div class="empty-note">Usage and outcome data are unavailable. Reload this page to try again.</div></section>`);
  const trendRows = summary.daily.map(day => `<tr><th scope="row">${esc(day.date)}</th><td>${day.runs}</td><td>${day.succeeded}</td><td>${day.failed}</td><td>${money(day.observedCostUsd)}</td><td>${day.runsWithKnownCost}/${day.runs}</td></tr>`).join('') || '<tr><td colspan="6">No daily data.</td></tr>';
  const runs = summary.recentRuns.map(run => `<li class="outcome-run"><a class="app-link" href="${esc(routeHref({ view: 'runs', repo: opts.selectedRepo, run: run.runId }))}">${esc(run.runId)}</a><span>Execution: ${esc(run.status)}</span><span>${run.costUsd === null && run.observedCostUsd !== null ? `${money(run.observedCostUsd)} reported · total unknown` : money(run.costUsd)}</span><span>${duration(run.durationMs)}</span>${assessmentForm(run, state.savingRunId === run.runId)}</li>`).join('') || `<li class="empty-note">No ${term('runs').toLowerCase()} started in this time period for the selected scope. Choose a longer period or another ${term('repository').toLowerCase()}.</li>`;
  return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view">
    ${intro}
    <div class="outcome-toolbar"><label>Time period <select data-outcome-days>${select}</select></label><span>${esc(dateLabel(summary.window.from))} to ${esc(dateLabel(summary.window.to))} (UTC)</span>${state.error ? `<span class="outcome-inline-error" role="alert">${esc(state.error)}</span>` : ''}</div>
    <div class="outcome-stats">${stat('Runs', String(summary.runs), `${summary.execution.succeeded} succeeded · ${summary.execution.failed} failed`)}${stat('Reported spend', money(summary.observedCostUsd), `${summary.runsWithKnownCost}/${summary.runs} runs fully priced · ${summary.costCoverage === null ? 'coverage unknown' : `${Math.round(summary.costCoverage * 100)}% coverage`}`)}${stat('Tokens', count(summary.totalTokens), `input ${count(summary.inputTokens)} · cached ${count(summary.cachedInputTokens)} · output ${count(summary.outputTokens)}`)}${stat('Average duration', duration(summary.averageDurationMs), `${summary.runsWithDuration}/${summary.runs} runs`)}${stat('Published / reviewed / merged', `${summary.publishedPrs} / ${summary.reviewedPrs} / ${summary.mergedPrs}`, `PR visibility: ${summary.unknownPrs} unknown · ${summary.stalePrs} stale · ${summary.unavailablePrs} unavailable`)}</div>
    <section class="panel"><div class="panel-head"><span class="panel-title">Cost per outcome</span></div><p class="empty-note">Reported spend includes partial costs and may be below the total. Per-PR costs require fully priced runs. Unknown means data is missing, not that the cost is zero.</p><div class="outcome-stats">${stat('Published PR', money(summary.costPerPublishedPrUsd))}${stat('Reviewed PR', money(summary.costPerReviewedPrUsd))}${stat('Merged PR', money(summary.costPerMergedPrUsd))}${stat('Correction rounds', count(summary.correctionRounds))}</div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Recorded failure stages</span></div><div class="outcome-tags">${summary.failures.length ? summary.failures.map(item => `<span>${esc(item.stage)} · ${item.count}</span>`).join('') : '<span>No failure stages recorded.</span>'}</div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Daily trend</span></div><div class="outcome-table-wrap" role="region" aria-label="Daily usage" tabindex="0"><table class="outcome-table"><thead><tr><th>Date</th><th>Runs</th><th>Succeeded</th><th>Failed</th><th>Reported spend</th><th>Fully priced runs</th></tr></thead><tbody>${trendRows}</tbody></table></div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">${term('recentRuns')}</span></div><ul class="outcome-runs">${runs}</ul></section>
  </section>`);
}
