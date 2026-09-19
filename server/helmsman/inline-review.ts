import type { GithubConfig } from '../config';
import { isGithubRepo } from '../pr-lists';
import { agentAttribution, appendAgentByline, stripAgentByline, type AgentAttribution } from './agent-attribution';

export interface InlineReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}

export interface InlineReviewInput {
  headSha?: string;
  comments: InlineReviewComment[];
  attribution?: AgentAttribution;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !/[\x00-\x1f\\]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function parseInlineReviewComments(raw: string | null): InlineReviewComment[] {
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Inline review comments must be a valid JSON array'); }
  if (!Array.isArray(parsed)) throw new Error('Inline review comments must be a JSON array');
  return parsed.map((value: unknown, index) => {
    const item = record(value);
    const fail = (reason: string): never => { throw new Error(`Inline review comment ${index + 1}: ${reason}`); };
    if (!item) return fail('expected an object');
    if (Object.keys(item).some(key => !['path', 'line', 'side', 'start_line', 'start_side', 'body'].includes(key))) return fail('unsupported field');
    if (!validPath(item.path)) return fail('path must be a relative repository file path');
    if (!positive(item.line)) return fail('line must be a positive integer');
    if (item.side !== 'LEFT' && item.side !== 'RIGHT') return fail('side must be LEFT or RIGHT');
    if (typeof item.body !== 'string' || !item.body.trim()) return fail('body must be nonempty text');
    const comment: InlineReviewComment = { path: item.path, line: item.line, side: item.side, body: item.body };
    if ('start_line' in item || 'start_side' in item) {
      if (!positive(item.start_line) || item.start_line >= item.line) return fail('start_line must be a positive integer before line');
      if (item.start_side !== item.side) return fail('start_side must match side');
      comment.start_line = item.start_line;
      comment.start_side = comment.side;
    }
    return comment;
  });
}

type Hunk = { LEFT: Set<number>; RIGHT: Set<number> };

function diffHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const finish = () => {
    if (hunk && oldRemaining === 0 && newRemaining === 0) hunks.push(hunk);
  };
  for (const row of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
    if (header) {
      finish();
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      hunk = { LEFT: new Set(), RIGHT: new Set() };
    } else if (hunk && row.startsWith(' ')) {
      hunk.LEFT.add(oldLine++);
      hunk.RIGHT.add(newLine++);
      oldRemaining--;
      newRemaining--;
    } else if (hunk && row.startsWith('-')) {
      hunk.LEFT.add(oldLine++);
      oldRemaining--;
    } else if (hunk && row.startsWith('+')) {
      hunk.RIGHT.add(newLine++);
      newRemaining--;
    } else if (row !== '\\ No newline at end of file' && row !== '') {
      hunk = null;
    }
  }
  finish();
  return hunks;
}

function anchored(comment: InlineReviewComment, hunks: Hunk[] | undefined): boolean {
  return hunks?.some(hunk => {
    const lines = hunk[comment.side];
    const start = comment.start_line ?? comment.line;
    if (comment.line - start + 1 > lines.size) return false;
    for (let line = start; line <= comment.line; line++) if (!lines.has(line)) return false;
    return true;
  }) ?? false;
}

function plainSuggestions(body: string): string {
  return body.replace(/^(\s*`{3,})suggestion(?:[^\r\n]*)$/gm, '$1');
}

function summaryFinding(comment: InlineReviewComment, reason: string): string {
  const path = comment.path.replace(/[\\`*_\[\]<>]/g, '\\$&');
  const range = comment.start_line ? `${comment.start_line}–${comment.line}` : String(comment.line);
  const body = plainSuggestions(stripAgentByline(comment.body));
  return `### ${path}:${range} (${comment.side})\n\n${reason}\n\n${body}`;
}

export async function publishInlineReview(
  github: GithubConfig,
  repo: string,
  prNumber: number,
  body: string,
  input: InlineReviewInput,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let posting = false;
  try {
    if (typeof repo !== 'string' || !isGithubRepo(repo) || !positive(prNumber)) throw new Error('Invalid GitHub galleon or PR number');
    if (typeof github?.token !== 'string' || !github.token.trim()) throw new Error('GitHub token is missing');
    if (typeof body !== 'string' || !body.trim()) throw new Error('Review summary must be nonempty text');
    if (!Array.isArray(input?.comments)) throw new Error('Inline review comments must be an array');
    const attribution = input.attribution ?? agentAttribution('unknown', {}, 'review agent');
    const comments = parseInlineReviewComments(JSON.stringify(input.comments));
    const sha = input.headSha;
    if (sha !== undefined && !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) throw new Error('Invalid pinned review head SHA');
    if (comments.length && !sha) throw new Error('Inline comments require the pinned review head SHA');
    const base = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
    const headers = { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const get = async (url: string): Promise<unknown> => {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`GitHub diff lookup failed (${response.status})`);
      return response.json();
    };
    const checkHead = async (): Promise<Record<string, unknown>> => {
      const detail = record(await get(base));
      const currentSha = record(detail?.head)?.sha;
      if (typeof currentSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(currentSha)) throw new Error('GitHub returned malformed PR head metadata');
      if (currentSha.toLowerCase() !== sha?.toLowerCase()) throw new Error('PR head changed since this review; no review was posted');
      return detail!;
    };
    const inline: InlineReviewComment[] = [];
    const fallback: string[] = [];
    if (comments.length) {
      const detail = await checkHead();
      const changedFiles = detail.changed_files;
      if (typeof changedFiles !== 'number' || !Number.isSafeInteger(changedFiles) || changedFiles < 0) throw new Error('GitHub returned malformed changed file count');
      const files = new Map<string, Hunk[]>();
      const limit = Math.min(changedFiles, 3_000);
      for (let page = 1; files.size < limit; page++) {
        const values = await get(`${base}/files?per_page=100&page=${page}`);
        if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error('GitHub returned an incomplete or malformed changed file listing');
        for (const value of values) {
          const file = record(value);
          if (!validPath(file?.filename) || files.has(file.filename)
            || (file.patch !== undefined && file.patch !== null && typeof file.patch !== 'string')) throw new Error('GitHub returned malformed changed file metadata');
          files.set(file.filename, typeof file.patch === 'string' ? diffHunks(file.patch) : []);
        }
        if (files.size > limit) throw new Error('GitHub changed file count did not match the listing');
        if (values.length < 100 && files.size < limit) throw new Error('GitHub returned an incomplete changed file listing');
      }
      for (const comment of comments) {
        if (!anchored(comment, files.get(comment.path))) fallback.push(summaryFinding(comment, 'Could not safely anchor this finding in the available diff.'));
        else if (inline.length >= 100) fallback.push(summaryFinding(comment, 'Inline comment limit reached.'));
        else inline.push(comment.side === 'LEFT' ? { ...comment, body: plainSuggestions(comment.body) } : comment);
      }
      await checkHead();
    }
    const summary = stripAgentByline(body);
    const reviewBody = appendAgentByline(fallback.length ? `${summary}\n\n## Findings retained in summary\n\n${fallback.join('\n\n')}` : summary, attribution);
    const publishedComments = inline.map(comment => ({ ...comment, body: appendAgentByline(comment.body, attribution) }));
    posting = true;
    const response = await fetcher(`${base}/reviews`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ event: 'COMMENT', body: reviewBody, ...(sha ? { commit_id: sha } : {}), ...(publishedComments.length ? { comments: publishedComments } : {}) }),
    });
    if (!response.ok) {
      const failure = record(await response.json().catch(() => null));
      throw new Error(typeof failure?.message === 'string' ? `GitHub ${response.status}: ${failure.message}` : `GitHub ${response.status}`);
    }
    const result = record(await response.json());
    if (!positive(result?.id)) throw new Error('GitHub returned a malformed review response');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: posting ? `${message}. Posting was attempted; check GitHub before retrying to avoid duplicates.` : message };
  }
}
