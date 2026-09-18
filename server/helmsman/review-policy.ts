import type { GithubConfig } from '../config';
import { isGithubRepo } from '../pr-lists';
import { validModel, validEffort } from '../../src/logic/agentOptions';

export type ReviewComplexity = 'low' | 'medium' | 'high';
export interface ReviewFile { filename: string; changes: number; patch: string | null }
export interface ReviewScope { files: ReviewFile[]; changedFiles: number; changedLines: number; complete: boolean; headSha: string }
export interface ReviewChoice { complexity: ReviewComplexity; reason: string; model?: string; effort?: string }

export function classifyReview(scope: ReviewScope | null): Pick<ReviewChoice, 'complexity' | 'reason'> {
  if (!scope?.complete || !scope.files.length || scope.changedFiles !== scope.files.length) {
    return { complexity: 'low', reason: 'Diff scope is incomplete; using the default low effort' };
  }
  const areas = new Set(scope.files.map(file => file.filename.split('/').slice(0, -1).slice(0, 2).join('/')));
  if (areas.size > 1 && (scope.changedFiles > 5 || scope.changedLines > 300)) {
    return { complexity: 'medium', reason: `${scope.changedFiles} files and ${scope.changedLines} changed lines across ${areas.size} areas` };
  }
  return { complexity: 'low', reason: `${scope.changedFiles} files and ${scope.changedLines} changed lines across ${areas.size} areas; default low effort` };
}

export function selectReviewModel(scope: ReviewScope | null, adapter: string, overrides: { model?: string; effort?: string } = {}): ReviewChoice {
  const choice = classifyReview(scope);
  const defaults = adapter === 'claude-code'
    ? { model: choice.complexity === 'high' ? 'opus' : 'sonnet', effort: choice.complexity === 'low' ? 'low' : choice.complexity === 'high' ? 'high' : 'medium' }
    : adapter === 'command' ? {}
    : {
      model: { low: 'gpt-5.6-terra', medium: 'gpt-5.6-sol', high: 'gpt-6-astra' }[choice.complexity],
      effort: { low: 'low', medium: 'medium', high: 'high' }[choice.complexity],
    };
  return { ...choice, model: validModel(overrides.model) ?? defaults.model, effort: validEffort(overrides.effort) ?? defaults.effort };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function fetchReviewHead(github: GithubConfig, repo: string, number: number, fetcher: typeof fetch = fetch) {
  if (!isGithubRepo(repo) || !Number.isSafeInteger(number) || number < 1) return null;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const pr = record(await response.json());
    const head = record(pr?.head);
    if (!head || typeof head.sha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head.sha)
      || typeof head.ref !== 'string' || !head.ref || !['open', 'closed'].includes(String(pr?.state))
      || typeof pr?.draft !== 'boolean') return null;
    return { number, headSha: head.sha, headRefName: head.ref, state: pr.state as 'open' | 'closed', draft: pr.draft, merged: pr.merged === true };
  } catch { return null; }
}

export async function fetchReviewScope(github: GithubConfig, repo: string, number: number, fetcher: typeof fetch = fetch): Promise<ReviewScope | null> {
  if (!isGithubRepo(repo) || !Number.isSafeInteger(number) || number < 1) return null;
  const options = () => ({
    headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  const base = `https://api.github.com/repos/${repo}/pulls/${number}`;
  try {
    const response = await fetcher(base, options());
    if (!response.ok) return null;
    const pr = record(await response.json());
    const headSha = record(pr?.head)?.sha;
    if (!count(pr?.changed_files) || !count(pr?.additions) || !count(pr?.deletions) || typeof headSha !== 'string' || !headSha) return null;
    const scope: ReviewScope = { files: [], changedFiles: pr.changed_files, changedLines: pr.additions + pr.deletions, complete: false, headSha };
    if (scope.changedFiles > 300) return scope;
    for (let page = 1; page <= 3; page++) {
      const filesResponse = await fetcher(`${base}/files?per_page=100&page=${page}`, options());
      if (!filesResponse.ok) return scope;
      const files: unknown = await filesResponse.json();
      if (!Array.isArray(files)) return scope;
      for (const value of files) {
        const file = record(value);
        if (typeof file?.filename !== 'string' || !file.filename || !count(file.changes)) return scope;
        scope.files.push({ filename: file.filename, changes: file.changes, patch: typeof file.patch === 'string' ? file.patch : null });
      }
      if (files.length < 100) break;
    }
    const unique = new Set(scope.files.map(file => file.filename));
    scope.complete = unique.size === scope.changedFiles && scope.files.length === scope.changedFiles
      && scope.files.every(file => Boolean(file.patch?.trim()));
    const verification = await fetcher(base, options());
    if (!verification.ok) return { ...scope, complete: false };
    const current = record(await verification.json());
    if (record(current?.head)?.sha !== headSha) return null;
    return scope;
  } catch { return null; }
}
