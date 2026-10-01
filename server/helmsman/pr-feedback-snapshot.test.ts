import { describe, expect, it, vi } from 'vitest';
import { collectFeedbackSnapshot, type FeedbackCommand } from './pr-feedback-snapshot';

const repo = 'org/project';
const prNumber = 42;
const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
const date = '2026-09-30T10:00:00Z';
const metadata = {
  number: prNumber, url: prUrl, body: 'Description\n\nFull context.', updatedAt: date,
  headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), headRefName: 'fix/feedback', baseRefName: 'main', state: 'OPEN',
};
const review = { id: 10, html_url: `${prUrl}#pullrequestreview-10`, body: 'Please address these findings.',
  state: 'CHANGES_REQUESTED', submitted_at: date };
const comment = { id: 20, html_url: `${prUrl}#issuecomment-20`, body: 'Edited bot summary', updated_at: date };
const inline = { id: 30, html_url: `${prUrl}#discussion_r30`, body: 'Outdated and resolved text still matters.', updated_at: date };

function fixture(options: {
  before?: unknown; after?: unknown; reviews?: unknown; comments?: unknown; inline?: unknown;
} = {}) {
  let metadataCalls = 0;
  const command = vi.fn<FeedbackCommand>(async (_file, args) => {
    if (args[0] === 'pr') {
      metadataCalls++;
      return JSON.stringify(metadataCalls === 1
        ? 'before' in options ? options.before : metadata
        : 'after' in options ? options.after : metadata);
    }
    const endpoint = args[1];
    if (endpoint?.includes('/reviews?')) return JSON.stringify('reviews' in options ? options.reviews : [[review]]);
    if (endpoint?.includes('/issues/')) return JSON.stringify('comments' in options ? options.comments : [[comment]]);
    if (endpoint?.includes('/pulls/')) return JSON.stringify('inline' in options ? options.inline : [[inline]]);
    throw new Error('Unexpected command');
  });
  return { command, collect: () => collectFeedbackSnapshot(repo, prNumber, command) };
}

describe('collectFeedbackSnapshot', () => {
  it('collects all REST pages, full bodies, metadata, description, review state and reply relationships', async () => {
    const longBody = `${'full discussion\n'.repeat(5000)}END`;
    const { command, collect } = fixture({
      reviews: [[review], [{ ...review, id: 11, html_url: `${prUrl}#pullrequestreview-11`, state: 'APPROVED', body: '' }]],
      comments: [[comment], [{ ...comment, id: 21, html_url: `${prUrl}#issuecomment-21`, body: longBody }]],
      inline: [[inline], [{ ...inline, id: 31, html_url: `${prUrl}/files#discussion_r31`, body: 'Reply', in_reply_to_id: 30 }]],
    });
    const snapshot = await collect();
    expect(snapshot).toMatchObject({ repo, prNumber, headSha: metadata.headRefOid, baseSha: metadata.baseRefOid,
      headBranch: 'fix/feedback', baseBranch: 'main', state: 'OPEN', fingerprint: expect.stringMatching(/^[a-f\d]{64}$/) });
    expect(snapshot.sources.map(source => source.id)).toEqual([
      'comment:20', 'comment:21', 'description:42', 'inline:30', 'inline:31', 'review:10', 'review:11',
    ]);
    expect(snapshot.sources.find(source => source.id === 'comment:21')?.body).toBe(longBody);
    expect(snapshot.sources.find(source => source.id === 'description:42')).toMatchObject({
      kind: 'description', body: metadata.body, url: prUrl, updatedAt: date,
    });
    expect(snapshot.sources.find(source => source.id === 'review:10')).toMatchObject({
      kind: 'review', state: 'CHANGES_REQUESTED', submittedAt: date, updatedAt: date,
    });
    expect(snapshot.sources.find(source => source.id === 'inline:31')?.replyTo).toBe('inline:30');
    expect(command).toHaveBeenCalledTimes(5);
    const calls = command.mock.calls;
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '42', '--repo', repo, '--json',
      'number,url,body,updatedAt,headRefOid,baseRefOid,headRefName,baseRefName,state']]);
    expect(calls[4]).toEqual(calls[0]);
    expect(calls.slice(1, 4)).toEqual([
      ['gh', ['api', `repos/${repo}/pulls/42/reviews?per_page=100`, '--paginate', '--slurp', '--method', 'GET']],
      ['gh', ['api', `repos/${repo}/issues/42/comments?per_page=100`, '--paginate', '--slurp', '--method', 'GET']],
      ['gh', ['api', `repos/${repo}/pulls/42/comments?per_page=100`, '--paginate', '--slurp', '--method', 'GET']],
    ]);
  });

  it('produces the same fingerprint across page order and page boundaries', async () => {
    const second = { ...comment, id: 21, html_url: `${prUrl}#issuecomment-21`, body: 'Second' };
    const first = await fixture({ comments: [[comment], [second]] }).collect();
    const reordered = await fixture({ comments: [[second, comment]] }).collect();
    expect(first).toEqual(reordered);
  });

  it.each([
    { body: 'New findings in existing bot comment' },
    { updated_at: '2026-09-30T11:00:00Z' },
  ])('invalidates the fingerprint when an existing summary is edited: %j', async patch => {
    const before = await fixture().collect();
    const after = await fixture({ comments: [[{ ...comment, ...patch }]] }).collect();
    expect(after.sources.map(source => source.id)).toEqual(before.sources.map(source => source.id));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('fingerprints review body edits, dismissal and recorded update timestamps', async () => {
    const original = await fixture().collect();
    for (const patch of [{ body: 'Edited review' }, { state: 'DISMISSED' }, { updated_at: '2026-09-30T12:00:00Z' }]) {
      const changed = await fixture({ reviews: [[{ ...review, ...patch }]] }).collect();
      expect(changed.fingerprint).not.toBe(original.fingerprint);
    }
  });

  it('retains an empty pending review with no submission timestamp', async () => {
    const snapshot = await fixture({ reviews: [[{ ...review, state: 'PENDING', submitted_at: null, body: '' }]] }).collect();
    expect(snapshot.sources.find(source => source.kind === 'review')).toMatchObject({
      body: '', state: 'PENDING', submittedAt: null, updatedAt: date,
    });
  });

  it.each([
    { headRefOid: 'c'.repeat(40) }, { baseRefOid: 'd'.repeat(40) }, { body: 'Changed description' },
    { headRefName: 'other-head' }, { baseRefName: 'release' }, { state: 'MERGED' }, { updatedAt: '2026-09-30T11:00:00Z' },
  ])('rejects PR changes while content is collected: %j', async patch => {
    await expect(fixture({ after: { ...metadata, ...patch } }).collect()).rejects.toThrow('changed during feedback collection');
  });

  it.each([{ headRefOid: 'c'.repeat(40) }, { baseRefOid: 'd'.repeat(40) }, { body: 'Another description' }, { state: 'CLOSED' }])(
    'fingerprints coherent revision/description/state changes: %j', async patch => {
      const original = await fixture().collect();
      const changed = await fixture({ before: { ...metadata, ...patch }, after: { ...metadata, ...patch } }).collect();
      expect(changed.fingerprint).not.toBe(original.fingerprint);
    },
  );

  it('accepts empty paginated discussions but keeps the description source', async () => {
    const snapshot = await fixture({ reviews: [[]], comments: [[]], inline: [[]] }).collect();
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]?.kind).toBe('description');
  });

  it.each([null, {}, [], { ...metadata, body: null }, { ...metadata, headRefOid: null },
    { ...metadata, baseRefOid: 'not-a-sha' }, { ...metadata, updatedAt: null }, { ...metadata, headRefName: '' },
    { ...metadata, number: 43 }, { ...metadata, state: 'unknown' }])('rejects malformed metadata: %j', async before => {
    const { command, collect } = fixture({ before });
    await expect(collect()).rejects.toThrow();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, [], [comment], [null], [[null]], [[{ ...comment, body: null }]],
    [[{ ...comment, updated_at: undefined }]], [[{ ...comment, updated_at: 'yesterday' }]],
    [[{ ...comment, id: Number.MAX_SAFE_INTEGER + 1 }]]])('rejects malformed comment pagination or fields: %j', async comments => {
    await expect(fixture({ comments }).collect()).rejects.toThrow();
  });

  it.each(['https://github.com/org/project/pull/420#issuecomment-20', 'https://github.com/other/project/pull/42',
    'https://github.com.example.net/org/project/pull/42', 'http://github.com/org/project/pull/42',
    'https://token@github.com/org/project/pull/42', 'https://github.com/org/project/issues/42'])('rejects mismatched source URL %s', async html_url => {
    await expect(fixture({ comments: [[{ ...comment, html_url }]] }).collect()).rejects.toThrow('source URL');
  });

  it('rejects a metadata URL for another PR and duplicated page entries', async () => {
    await expect(fixture({ before: { ...metadata, url: `${prUrl}0` } }).collect()).rejects.toThrow('source URL');
    await expect(fixture({ comments: [[comment], [comment]] }).collect()).rejects.toThrow('Duplicate GitHub feedback source comment:20');
  });

  it('rejects malformed review state, submission time and inline reply IDs', async () => {
    for (const patch of [{ state: null }, { state: 'UNKNOWN' }, { submitted_at: null }, { submitted_at: undefined }, { updated_at: null }]) {
      await expect(fixture({ reviews: [[{ ...review, ...patch }]] }).collect()).rejects.toThrow();
    }
    await expect(fixture({ inline: [[{ ...inline, in_reply_to_id: '30' }]] }).collect()).rejects.toThrow('reply ID');
  });

  it('propagates command/API failures and rejects non-JSON output without a partial snapshot', async () => {
    const failed = fixture();
    failed.command.mockRejectedValueOnce(new Error('gh: HTTP 403'));
    await expect(failed.collect()).rejects.toThrow('HTTP 403');
    const invalid = fixture();
    invalid.command.mockResolvedValueOnce('not JSON');
    await expect(invalid.collect()).rejects.toThrow('Malformed GitHub PR metadata JSON');
    const apiError = fixture();
    apiError.command.mockImplementation(async (_file, args) => args[0] === 'pr' ? JSON.stringify(metadata) : '{"message":"API rate limit exceeded"}');
    await expect(apiError.collect()).rejects.toThrow('pagination');
  });

  it.each([['org/project;rm', 42], ['org/project', 0], ['org/project', 1.5], ['org/project', NaN]])(
    'rejects invalid identity without running commands: %s %s', async (invalidRepo, number) => {
      const command = vi.fn<FeedbackCommand>();
      await expect(collectFeedbackSnapshot(String(invalidRepo), Number(number), command)).rejects.toThrow('identity');
      expect(command).not.toHaveBeenCalled();
    },
  );
});
