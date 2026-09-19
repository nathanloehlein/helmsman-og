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
  return `<details class="outcome-assessment"><summary>Assess ${esc(run.runId)}</summary><form data-outcome-assessment="${esc(run.runId)}">
    <label>Assessment <select name="state"><option value="not-assessed"${assessment?.state === 'not-assessed' ? ' selected' : ''}>Not assessed</option><option value="complete"${assessment?.state === 'complete' ? ' selected' : ''}>Complete</option><option value="partial"${assessment?.state === 'partial' ? ' selected' : ''}>Partial</option><option value="failed"${assessment?.state === 'failed' ? ' selected' : ''}>Failed</option></select></label>
    <label>Outcome <select name="outcome"><option value="unknown"${assessment?.outcome === 'unknown' ? ' selected' : ''}>Unknown</option><option value="achieved"${assessment?.outcome === 'achieved' ? ' selected' : ''}>Achieved</option><option value="partial"${assessment?.outcome === 'partial' ? ' selected' : ''}>Partial</option><option value="not-achieved"${assessment?.outcome === 'not-achieved' ? ' selected' : ''}>Not achieved</option></select></label>
    <label>Summary <textarea name="summary" maxlength="4000">${esc(assessment?.summary ?? '')}</textarea></label>
    <label>Evidence <textarea name="evidence" placeholder="One URL, PR, test, or note per line">${esc((assessment?.evidence ?? []).join('\n'))}</textarea></label>
    <label>Failure stage <input name="failureStage" value="${esc(assessment?.failureStage ?? '')}"></label><label>Correction rounds <input name="correctionRounds" type="number" min="0" step="1" value="${assessment?.correctionRounds ?? ''}"></label>
    <button type="submit"${saving ? ' disabled aria-busy="true"' : ''}>${saving ? 'Saving…' : 'Save assessment'}</button><span class="outcome-save-error" role="alert"></span>
  </form></details>`;
}

export function renderOutcomesView(state: OutcomesViewState, opts: HelmHeadOpts): string {
  const summary = state.summary;
  const select = [7, 30, 90, 365].map(days => `<option value="${days}"${state.days === days ? ' selected' : ''}>${days} days</option>`).join('');
  if (state.loading && !summary) return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view"><div class="outcome-toolbar"><label>Window <select data-outcome-days>${select}</select></label></div><div class="empty-note" role="status">Loading ${term('costsOutcomes').toLowerCase()}…</div></section>`);
  if (state.error && !summary) return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view"><div class="outcome-toolbar"><label>Window <select data-outcome-days>${select}</select></label></div><div class="degraded-banner" role="alert">${esc(state.error)}</div></section>`);
  if (!summary) return renderAppShell({ ...opts, active: 'outcomes' }, '<div class="empty-note">Outcomes unavailable.</div>');
  const trendRows = summary.daily.map(day => `<tr><th scope="row">${esc(day.date)}</th><td>${day.runs}</td><td>${day.succeeded}</td><td>${day.failed}</td><td>${money(day.observedCostUsd)}</td><td>${day.runsWithKnownCost}/${day.runs}</td></tr>`).join('') || '<tr><td colspan="6">No daily data.</td></tr>';
  const runs = summary.recentRuns.map(run => `<li class="outcome-run"><a class="app-link" href="${esc(routeHref({ view: 'runs', repo: opts.selectedRepo, run: run.runId }))}">${esc(run.runId)}</a><span>${esc(run.status)}</span><span>${run.costUsd === null && run.observedCostUsd !== null ? `${money(run.observedCostUsd)} reported · total unknown` : money(run.costUsd)}</span><span>${duration(run.durationMs)}</span>${assessmentForm(run, state.savingRunId === run.runId)}</li>`).join('') || '<li class="empty-note">No recent runs.</li>';
  return renderAppShell({ ...opts, active: 'outcomes' }, `<section class="outcomes-view">
    <div class="outcome-toolbar"><label>Window <select data-outcome-days>${select}</select></label><span>${esc(dateLabel(summary.window.from))} to ${esc(dateLabel(summary.window.to))} (UTC)</span>${state.error ? `<span class="outcome-inline-error" role="alert">${esc(state.error)}</span>` : ''}</div>
    <div class="outcome-stats">${stat('Runs', String(summary.runs), `${summary.execution.succeeded} succeeded · ${summary.execution.failed} failed`)}${stat('Reported spend', money(summary.observedCostUsd), `${summary.runsWithKnownCost}/${summary.runs} runs fully priced · ${summary.costCoverage === null ? 'coverage unknown' : `${Math.round(summary.costCoverage * 100)}% coverage`}`)}${stat('Tokens', count(summary.totalTokens), `input ${count(summary.inputTokens)} · cached ${count(summary.cachedInputTokens)} · output ${count(summary.outputTokens)}`)}${stat('Average duration', duration(summary.averageDurationMs), `${summary.runsWithDuration}/${summary.runs} runs`)}${stat('Published / reviewed / merged', `${summary.publishedPrs} / ${summary.reviewedPrs} / ${summary.mergedPrs}`, `PR visibility: ${summary.unknownPrs} unknown · ${summary.stalePrs} stale · ${summary.unavailablePrs} unavailable`)}</div>
    <section class="panel"><div class="panel-head"><span class="panel-title">Cost per outcome</span></div><p class="empty-note">Reported spend includes partial costs. Per-PR costs require fully priced runs.</p><div class="outcome-stats">${stat('Published PR', money(summary.costPerPublishedPrUsd))}${stat('Reviewed PR', money(summary.costPerReviewedPrUsd))}${stat('Merged PR', money(summary.costPerMergedPrUsd))}${stat('Correction rounds', count(summary.correctionRounds))}</div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Failure stages</span></div><div class="outcome-tags">${summary.failures.length ? summary.failures.map(item => `<span>${esc(item.stage)} · ${item.count}</span>`).join('') : '<span>None known</span>'}</div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Daily trend</span></div><table class="outcome-table"><thead><tr><th>Date</th><th>Runs</th><th>Succeeded</th><th>Failed</th><th>Reported spend</th><th>Fully priced runs</th></tr></thead><tbody>${trendRows}</tbody></table></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Recent runs</span></div><ul class="outcome-runs">${runs}</ul></section>
  </section>`);
}
