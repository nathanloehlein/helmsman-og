import Database from 'better-sqlite3';
import { isGithubRepo } from '../pr-lists';
import type { RunRow } from './db';
import {
  ASSESSMENT_STATES, TASK_OUTCOMES,
  type OutcomeAssessment, type ProviderUsage, type OutcomePullRequest, type OutcomeSummary, type OutcomeDay, type OutcomeRun,
} from '../../src/data/outcomes';

export class OutcomeValidationError extends Error {}
export class UsageConflictError extends Error {}

export interface OutcomeStore {
  saveAssessment(input: unknown): OutcomeAssessment;
  getAssessment(runId: string): OutcomeAssessment | null;
  listAssessments(runIds: string[]): OutcomeAssessment[];
  recordUsage(input: unknown): boolean;
  listUsage(runIds: string[]): ProviderUsage[];
  close(): void;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OutcomeValidationError('Expected an outcome object');
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new OutcomeValidationError('Unknown outcome field');
}

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new OutcomeValidationError(`Invalid ${name}`);
  }
  return value.trim();
}

function runId(value: unknown): string {
  const id = text(value, 'run ID', 128);
  if (!/^[a-z\d_-]+$/i.test(id)) throw new OutcomeValidationError('Invalid run ID');
  return id;
}

function number(value: unknown, name: string, integer = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || integer && !Number.isSafeInteger(value)) {
    throw new OutcomeValidationError(`Invalid ${name}`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new OutcomeValidationError('Expected a UTC timestamp');
  }
  const canonical = new Date(value).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) throw new OutcomeValidationError('Invalid UTC date');
  return canonical;
}

function assessment(input: unknown, updatedAt: string): OutcomeAssessment {
  const value = record(input);
  fields(value, ['runId', 'state', 'outcome', 'summary', 'evidence', 'failureStage', 'correctionRounds', 'source']);
  if (value.source !== undefined && value.source !== 'manual' && value.source !== 'telemetry') throw new OutcomeValidationError('Invalid assessment source');
  const state = ASSESSMENT_STATES.find(state => state === value.state);
  const outcome = TASK_OUTCOMES.find(outcome => outcome === value.outcome);
  if (!state || !outcome) throw new OutcomeValidationError('Invalid assessment state or task outcome');
  if ((state === 'not-assessed' || state === 'failed') && outcome !== 'unknown') {
    throw new OutcomeValidationError('An incomplete or failed assessment cannot claim a task outcome');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 30) throw new OutcomeValidationError('Provide at most 30 evidence references');
  const evidence = [...new Set(value.evidence.map(item => text(item, 'evidence reference', 2000)))];
  if (outcome !== 'unknown' && evidence.length === 0) throw new OutcomeValidationError('A task outcome requires evidence');
  const rounds = number(value.correctionRounds, 'correction rounds', true);
  if (rounds !== null && rounds > 100) throw new OutcomeValidationError('Too many correction rounds');
  return {
    runId: runId(value.runId), state, outcome, source: value.source ?? 'manual',
    summary: text(value.summary, 'assessment summary', 4000), evidence,
    failureStage: value.failureStage === undefined || value.failureStage === null ? null : text(value.failureStage, 'failure stage', 120),
    correctionRounds: rounds, updatedAt,
  };
}

function usage(input: unknown): ProviderUsage {
  const value = record(input);
  fields(value, ['runId', 'attempt', 'eventId', 'provider', 'model', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd']);
  const attempt = number(value.attempt, 'attempt', true);
  if (attempt === null || attempt < 1 || attempt > 10000) throw new OutcomeValidationError('Invalid attempt');
  const result: ProviderUsage = {
    runId: runId(value.runId), attempt, eventId: text(value.eventId, 'usage event ID', 256),
    provider: text(value.provider, 'provider', 80),
    model: value.model === undefined || value.model === null ? null : text(value.model, 'model', 160),
    inputTokens: number(value.inputTokens, 'input tokens', true),
    cachedInputTokens: number(value.cachedInputTokens, 'cached input tokens', true),
    outputTokens: number(value.outputTokens, 'output tokens', true),
    totalTokens: number(value.totalTokens, 'total tokens', true), costUsd: number(value.costUsd, 'cost'),
  };
  if (result.inputTokens === null && result.cachedInputTokens === null && result.outputTokens === null && result.totalTokens === null && result.costUsd === null) {
    throw new OutcomeValidationError('Usage must include tokens or a known cost');
  }
  return result;
}

export function openOutcomeStore(path: string, now: () => string = () => new Date().toISOString()): OutcomeStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS outcome_assessments (runId TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outcome_usage (
      runId TEXT NOT NULL, attempt INTEGER NOT NULL, eventId TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (runId, attempt, eventId)
    );
  `);
  const read = sql.prepare('SELECT payload FROM outcome_assessments WHERE runId = ?');
  const usageRead = sql.prepare('SELECT payload FROM outcome_usage WHERE runId = ? AND attempt = ? AND eventId = ?');
  const usageList = sql.prepare('SELECT payload FROM outcome_usage WHERE runId = ? ORDER BY attempt, eventId');
  const decode = (row: unknown): Record<string, unknown> | null => {
    if (row === undefined || row === null) return null;
    const stored = record(row);
    if (typeof stored.payload !== 'string') throw new OutcomeValidationError('Stored outcome data is invalid');
    try { return record(JSON.parse(stored.payload)); }
    catch { throw new OutcomeValidationError('Stored outcome data is invalid'); }
  };
  const readAssessment = (row: unknown): OutcomeAssessment | null => {
    const value = decode(row);
    if (!value) return null;
    const { updatedAt, ...input } = value;
    return assessment(input, timestamp(updatedAt));
  };
  const readUsage = (row: unknown): ProviderUsage | null => {
    const value = decode(row);
    return value ? usage(value) : null;
  };
  const ids = (values: string[]): string[] => {
    if (!Array.isArray(values) || values.length > 100000) throw new OutcomeValidationError('Invalid run selection');
    return [...new Set(values.map(runId))];
  };
  return {
    saveAssessment(input) {
      const item = assessment(input, timestamp(now()));
      sql.prepare('INSERT INTO outcome_assessments (runId, payload) VALUES (?, ?) ON CONFLICT(runId) DO UPDATE SET payload = excluded.payload')
        .run(item.runId, JSON.stringify(item));
      return item;
    },
    getAssessment: id => readAssessment(read.get(runId(id))),
    listAssessments: runIds => ids(runIds).flatMap(id => {
      const item = readAssessment(read.get(id));
      return item ? [item] : [];
    }),
    recordUsage: sql.transaction((input: unknown): boolean => {
      const item = usage(input);
      const prior = readUsage(usageRead.get(item.runId, item.attempt, item.eventId));
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(item)) throw new UsageConflictError('Usage event already exists with different values');
        return false;
      }
      sql.prepare('INSERT INTO outcome_usage (runId, attempt, eventId, payload) VALUES (?, ?, ?, ?)')
        .run(item.runId, item.attempt, item.eventId, JSON.stringify(item));
      return true;
    }).immediate,
    listUsage: runIds => ids(runIds).flatMap(id => usageList.all(id).flatMap(row => { const item = readUsage(row); return item ? [item] : []; })),
    close: () => sql.close(),
  };
}

export interface AggregateOutcomesInput {
  runs: RunRow[];
  assessments?: OutcomeAssessment[];
  usage?: ProviderUsage[];
  pullRequests?: OutcomePullRequest[];
  from: string;
  to: string;
  repo?: string | null;
}

const DAY = 86_400_000;
const prKey = (repo: string, pr: number): string => `${repo.toLowerCase()}#${pr}`;
const sum = (values: number[]): number | null => values.length ? values.reduce((total, value) => total + value, 0) : null;

export function aggregateOutcomes(input: AggregateOutcomesInput): OutcomeSummary {
  if (!input || typeof input !== 'object') throw new OutcomeValidationError('Invalid outcome aggregation');
  const from = timestamp(input.from);
  const to = timestamp(input.to);
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (end <= start || end - start > 366 * DAY) throw new OutcomeValidationError('Choose a window from one instant up to 366 days');
  if (input.repo !== undefined && input.repo !== null && !isGithubRepo(input.repo)) throw new OutcomeValidationError('Invalid galleon');
  if (!Array.isArray(input.runs)) throw new OutcomeValidationError('Invalid run selection');
  const selected = new Map<string, RunRow>();
  for (const run of input.runs) {
    if (!run || typeof run.id !== 'string' || !isGithubRepo(run.repo) || !['running', 'succeeded', 'failed', 'stopped'].includes(run.status)) continue;
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started) || started < start || started >= end || input.repo && run.repo.toLowerCase() !== input.repo.toLowerCase()) continue;
    selected.set(run.id, run);
  }
  if (input.assessments != null && !Array.isArray(input.assessments) || input.usage != null && !Array.isArray(input.usage)
    || input.pullRequests != null && !Array.isArray(input.pullRequests)) throw new OutcomeValidationError('Invalid outcome records');
  const assessments = new Map<string, OutcomeAssessment>();
  for (const item of input.assessments ?? []) {
    if (!item || !selected.has(item.runId)) continue;
    const { updatedAt, ...values } = item;
    const valid = assessment(values, timestamp(updatedAt));
    const previous = assessments.get(valid.runId);
    if (!previous || previous.updatedAt <= valid.updatedAt) assessments.set(valid.runId, valid);
  }
  const events = new Map<string, ProviderUsage>();
  for (const item of input.usage ?? []) {
    if (!item || !selected.has(item.runId)) continue;
    const valid = usage(item);
    const key = JSON.stringify([valid.runId, valid.attempt, valid.eventId]);
    const prior = events.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(valid)) throw new UsageConflictError('Conflicting usage records');
    events.set(key, valid);
  }
  const usageByRun = new Map<string, ProviderUsage[]>();
  for (const item of events.values()) usageByRun.set(item.runId, [...(usageByRun.get(item.runId) ?? []), item]);
  const result: OutcomeSummary = {
    window: { from, to }, repo: input.repo ?? null, runs: selected.size,
    execution: { running: 0, succeeded: 0, failed: 0, stopped: 0 },
    assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 0 },
    outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 0 },
    knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costCoverage: null, averageCostUsd: null,
    averageDurationMs: null, runsWithDuration: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null,
    linkedPrs: 0, unknownPrs: 0, stalePrs: 0, unavailablePrs: 0,
    publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0,
    costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null,
    correctionRounds: null, failures: [], daily: [], recentRuns: [],
  };
  const days = new Map<string, OutcomeDay>();
  for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    days.set(date, { date, runs: 0, succeeded: 0, failed: 0, stopped: 0, running: 0, knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0 });
  }
  const failures = new Map<string, number>();
  const durations: number[] = [];
  const costs: number[] = [];
  const observedCosts: number[] = [];
  const corrections: number[] = [];
  const allRuns: OutcomeRun[] = [];
  for (const run of selected.values()) {
    const reports = usageByRun.get(run.id) ?? [];
    const cost = reports.length
      ? reports.every(item => item.costUsd !== null) ? sum(reports.map(item => item.costUsd!)) : null
      : typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) && run.costUsd >= 0 ? run.costUsd : null;
    const observedCost = reports.length ? sum(reports.flatMap(item => item.costUsd === null ? [] : [item.costUsd])) : cost;
    const duration = run.status !== 'running' && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : NaN;
    const durationMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
    const report = assessments.get(run.id) ?? null;
    result.execution[run.status]++;
    result.assessments[report?.state ?? 'not-assessed']++;
    result.outcomes[report?.outcome ?? 'unknown']++;
    if (report?.correctionRounds !== null && report?.correctionRounds !== undefined) corrections.push(report.correctionRounds);
    if (run.status === 'failed' || report?.outcome === 'not-achieved') {
      const stage = report?.failureStage ?? 'unknown';
      failures.set(stage, (failures.get(stage) ?? 0) + 1);
    }
    if (durationMs !== null) durations.push(durationMs);
    const day = days.get(new Date(run.startedAt).toISOString().slice(0, 10));
    if (day) { day.runs++; day[run.status]++; }
    if (cost !== null) {
      costs.push(cost);
      if (day) { day.knownCostUsd = (day.knownCostUsd ?? 0) + cost; day.runsWithKnownCost++; }
    }
    if (observedCost !== null) {
      observedCosts.push(observedCost);
      if (day) day.observedCostUsd = (day.observedCostUsd ?? 0) + observedCost;
    }
    allRuns.push({ runId: run.id, repo: run.repo, status: run.status, prNumber: run.prNumber,
      startedAt: run.startedAt, durationMs, costUsd: cost, observedCostUsd: observedCost, assessment: report });
  }
  const linkedPrs = new Set(allRuns.flatMap(run => Number.isSafeInteger(run.prNumber) && run.prNumber! > 0 ? [prKey(run.repo, run.prNumber!)] : []));
  const prs = new Map<string, OutcomePullRequest>();
  const unavailable = new Map<string, 'stale' | 'unavailable'>();
  for (const pr of input.pullRequests ?? []) {
    if (!pr || !isGithubRepo(pr.repo) || !Number.isSafeInteger(pr.number) || pr.number < 1
      || typeof pr.published !== 'boolean' || typeof pr.reviewed !== 'boolean' || typeof pr.merged !== 'boolean') continue;
    const key = prKey(pr.repo, pr.number);
    if (!linkedPrs.has(key)) continue;
    if (pr.availability === 'stale' || pr.availability === 'unavailable') {
      if (!prs.has(key)) unavailable.set(key, pr.availability);
      continue;
    }
    if (pr.availability !== undefined && pr.availability !== 'known') continue;
    unavailable.delete(key);
    const old = prs.get(key);
    prs.set(key, { ...pr, published: pr.published || old?.published === true, reviewed: pr.reviewed || old?.reviewed === true, merged: pr.merged || old?.merged === true });
  }
  const prStats = (kind: 'published' | 'reviewed' | 'merged') => {
    const keys = new Set([...prs].filter(([, pr]) => pr[kind]).map(([key]) => key));
    const runs = allRuns.filter(run => run.prNumber !== null && keys.has(prKey(run.repo, run.prNumber)));
    return { count: keys.size, cost: keys.size && runs.length && runs.every(run => run.costUsd !== null)
      ? runs.reduce((total, run) => total + run.costUsd!, 0) / keys.size : null };
  };
  const published = prStats('published');
  const reviewed = prStats('reviewed');
  const merged = prStats('merged');
  result.publishedPrs = published.count; result.costPerPublishedPrUsd = published.cost;
  result.reviewedPrs = reviewed.count; result.costPerReviewedPrUsd = reviewed.cost;
  result.mergedPrs = merged.count; result.costPerMergedPrUsd = merged.cost;
  result.linkedPrs = linkedPrs.size;
  result.unknownPrs = linkedPrs.size - prs.size;
  result.stalePrs = [...unavailable.values()].filter(state => state === 'stale').length;
  result.unavailablePrs = [...unavailable.values()].filter(state => state === 'unavailable').length;
  result.knownCostUsd = sum(costs);
  result.observedCostUsd = sum(observedCosts);
  result.runsWithKnownCost = costs.length;
  result.costCoverage = selected.size ? costs.length / selected.size : null;
  result.averageCostUsd = costs.length ? result.knownCostUsd! / costs.length : null;
  result.averageDurationMs = durations.length ? sum(durations)! / durations.length : null;
  result.runsWithDuration = durations.length;
  result.inputTokens = sum([...events.values()].flatMap(item => item.inputTokens === null ? [] : [item.inputTokens]));
  result.cachedInputTokens = sum([...events.values()].flatMap(item => item.cachedInputTokens === null ? [] : [item.cachedInputTokens]));
  result.outputTokens = sum([...events.values()].flatMap(item => item.outputTokens === null ? [] : [item.outputTokens]));
  result.totalTokens = sum([...events.values()].flatMap(item => item.totalTokens === null ? [] : [item.totalTokens]));
  result.correctionRounds = sum(corrections);
  result.failures = [...failures].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));
  result.daily = [...days.values()];
  result.recentRuns = allRuns.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.runId.localeCompare(b.runId)).slice(0, 100);
  return result;
}
