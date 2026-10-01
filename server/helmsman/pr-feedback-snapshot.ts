import { createHash } from 'node:crypto';
import { isGithubRepo } from '../pr-lists';

export interface FeedbackSource {
  id: string;
  url: string;
  body: string;
  kind: 'description' | 'review' | 'comment' | 'inline';
  updatedAt: string;
  replyTo?: string;
  state?: string;
  submittedAt?: string | null;
}

export interface FeedbackSnapshot {
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  sources: FeedbackSource[];
  fingerprint: string;
}

export type FeedbackCommand = (file: string, args: string[]) => Promise<string>;

type Metadata = Omit<FeedbackSnapshot, 'sources' | 'fingerprint'> & { body: string; url: string; updatedAt: string };
const METADATA_FIELDS = 'number,url,body,updatedAt,headRefOid,baseRefOid,headRefName,baseRefName,state';
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid GitHub ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`Invalid GitHub ${label}`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`Invalid GitHub ${label}`);
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid GitHub ${label}`);
  return String(value);
}

function sha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(result)) throw new Error(`Invalid GitHub ${label}`);
  return result.toLowerCase();
}

function prUrl(value: unknown, repo: string, prNumber: number): string {
  const result = string(value, 'source URL');
  let url: URL;
  try { url = new URL(result); } catch { throw new Error('Invalid GitHub source URL'); }
  const path = url.pathname.toLowerCase();
  const expected = `/${repo.toLowerCase()}/pull/${prNumber}`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || (path !== expected && !path.startsWith(`${expected}/`))) {
    throw new Error('GitHub source URL does not match the requested pull request');
  }
  return result;
}

function parseJson(output: string, label: string): unknown {
  try { return JSON.parse(output) as unknown; }
  catch (cause) { throw new Error(`Malformed GitHub ${label} JSON`, { cause }); }
}

function parseMetadata(output: string, repo: string, prNumber: number): Metadata {
  const item = record(parseJson(output, 'PR metadata'), 'PR metadata');
  if (item.number !== prNumber) throw new Error('GitHub returned a different pull request number');
  const state = item.state;
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw new Error('Invalid GitHub PR state');
  return {
    repo, prNumber,
    headSha: sha(item.headRefOid, 'head SHA'),
    baseSha: sha(item.baseRefOid, 'base SHA'),
    headBranch: string(item.headRefName, 'head branch'),
    baseBranch: string(item.baseRefName, 'base branch'),
    state,
    body: string(item.body, 'description body', true),
    url: prUrl(item.url, repo, prNumber),
    updatedAt: timestamp(item.updatedAt, 'PR update timestamp'),
  };
}

function parseSources(output: string, kind: 'review' | 'comment' | 'inline', metadata: Metadata): FeedbackSource[] {
  const pages = parseJson(output, `${kind} pages`);
  if (!Array.isArray(pages) || !pages.length || pages.some((page: unknown) => !Array.isArray(page))) {
    throw new Error(`Malformed GitHub ${kind} pagination`);
  }
  return pages.flatMap((page: unknown[]) => page.map((value: unknown): FeedbackSource => {
    const item = record(value, kind);
    const source: FeedbackSource = {
      id: `${kind}:${id(item.id, `${kind} ID`)}`,
      url: prUrl(item.html_url, metadata.repo, metadata.prNumber),
      body: string(item.body, `${kind} body`, true),
      kind,
      updatedAt: '',
    };
    if (kind === 'review') {
      const state = string(item.state, 'review state');
      if (!REVIEW_STATES.has(state)) throw new Error('Invalid GitHub review state');
      const submittedAt = state === 'PENDING' && item.submitted_at === null
        ? null : timestamp(item.submitted_at, 'review submission timestamp');
      source.state = state;
      source.submittedAt = submittedAt;
      // REST reviews omit edit timestamps, so the fingerprint also includes their full body and state.
      source.updatedAt = item.updated_at === undefined
        ? submittedAt ?? metadata.updatedAt : timestamp(item.updated_at, 'review update timestamp');
    } else {
      source.updatedAt = timestamp(item.updated_at, `${kind} update timestamp`);
    }
    if (kind === 'inline' && item.in_reply_to_id !== undefined && item.in_reply_to_id !== null) {
      source.replyTo = `inline:${id(item.in_reply_to_id, 'inline reply ID')}`;
    }
    return source;
  }));
}

export async function collectFeedbackSnapshot(repo: string, prNumber: number, command: FeedbackCommand): Promise<FeedbackSnapshot> {
  if (typeof repo !== 'string' || !isGithubRepo(repo) || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('Invalid GitHub pull request identity');
  }
  const metadataArgs = ['pr', 'view', String(prNumber), '--repo', repo, '--json', METADATA_FIELDS];
  const before = parseMetadata(await command('gh', metadataArgs), repo, prNumber);
  const endpoints = [
    ['review', `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`],
    ['comment', `repos/${repo}/issues/${prNumber}/comments?per_page=100`],
    ['inline', `repos/${repo}/pulls/${prNumber}/comments?per_page=100`],
  ] as const;
  const collected = await Promise.all(endpoints.map(async ([kind, endpoint]) => {
    const output = await command('gh', ['api', endpoint, '--paginate', '--slurp', '--method', 'GET']);
    return parseSources(output, kind, before);
  }));
  const after = parseMetadata(await command('gh', metadataArgs), repo, prNumber);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Pull request changed during feedback collection; retry');
  const sources: FeedbackSource[] = [
    { id: `description:${prNumber}`, kind: 'description', url: before.url, body: before.body, updatedAt: before.updatedAt },
    ...collected.flat(),
  ];
  sources.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new Error(`Duplicate GitHub feedback source ${source.id}`);
    seen.add(source.id);
  }
  const { body: _body, url: _url, updatedAt: _updatedAt, ...snapshot } = before;
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...snapshot, repo: repo.toLowerCase(), sources })).digest('hex');
  return { ...snapshot, sources, fingerprint };
}
