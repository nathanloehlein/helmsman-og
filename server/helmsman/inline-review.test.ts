import { describe, expect, it, vi } from 'vitest';
import { parseInlineReviewComments, publishInlineReview, type InlineReviewComment } from './inline-review';

const github = { token: 'test-token', repo: 'owner/repo', author: 'reviewer' };
const sha = 'a'.repeat(40);
const comment: InlineReviewComment = { path: 'src/example.ts', line: 11, side: 'RIGHT', body: 'Guard absent values.\n\n```suggestion\nreturn input?.value;\n```' };
const patch = '@@ -10,4 +10,4 @@\n context\n-old\n+new\n context\n context';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const detail = (count = 1, headSha = sha) => ({ head: { sha: headSha }, changed_files: count });

function setup(files: unknown = [{ filename: comment.path, patch }]) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json(detail()))
    .mockResolvedValueOnce(json(files))
    .mockResolvedValueOnce(json(detail()))
    .mockResolvedValueOnce(json({ id: 123 }, 201));
}

function payload(fetcher: ReturnType<typeof setup>) {
  const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  return JSON.parse(String(call?.[1]?.body));
}

describe('parseInlineReviewComments', () => {
  it('supports absent legacy sidecars and explicit empty arrays', () => {
    expect(parseInlineReviewComments(null)).toEqual([]);
    expect(parseInlineReviewComments('[]')).toEqual([]);
    expect(parseInlineReviewComments(JSON.stringify([comment]))).toEqual([comment]);
  });

  it.each(['', 'not json', '{}', '[null]', '[3]'])('rejects malformed sidecars: %s', raw => {
    expect(() => parseInlineReviewComments(raw)).toThrow(/Inline review/);
  });

  it.each([
    { path: '../outside.ts' }, { path: '/absolute.ts' }, { path: 'src\n/file.ts' },
    { line: 0 }, { line: 1.5 }, { line: '11' }, { side: 'right' }, { body: '' },
    { start_line: 10 }, { start_side: 'RIGHT' }, { start_line: 11, start_side: 'RIGHT' },
    { start_line: 10, start_side: 'LEFT' }, { arbitrary: true },
  ])('rejects invalid fields: %j', override => {
    expect(() => parseInlineReviewComments(JSON.stringify([{ ...comment, ...override }]))).toThrow(/Inline review comment 1:/);
  });
});

describe('publishInlineReview', () => {
  it('posts one COMMENT review containing the pinned SHA, summary, inline finding and suggestion', async () => {
    const fetcher = setup();
    expect(await publishInlineReview(github, 'owner/repo', 42, 'Review summary', { headSha: sha, comments: [comment] }, fetcher)).toEqual({ ok: true });
    expect(payload(fetcher)).toEqual({ event: 'COMMENT', body: 'Review summary', commit_id: sha, comments: [comment] });
    const post = fetcher.mock.calls[3];
    expect(post?.[0]).toBe('https://api.github.com/repos/owner/repo/pulls/42/reviews');
    expect(post?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('validates deletion and multiline right-side anchors using hunk lines', async () => {
    const findings: InlineReviewComment[] = [
      { ...comment, side: 'LEFT', body: 'Deleted guard was necessary.' },
      { ...comment, line: 13, start_line: 11, start_side: 'RIGHT' },
    ];
    const fetcher = setup();
    expect(await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: findings }, fetcher)).toEqual({ ok: true });
    expect(payload(fetcher).comments).toEqual(findings);
  });

  it('preserves fix samples on deleted lines as ordinary code fences', async () => {
    const fetcher = setup();
    await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [{ ...comment, side: 'LEFT' }] }, fetcher);
    expect(payload(fetcher).comments[0].body).toContain('```\nreturn input?.value;\n```');
    expect(payload(fetcher).comments[0].body).not.toContain('```suggestion');
  });

  it('does not anchor additions on the left, deletions on the right, or ranges spanning hunks', async () => {
    const specificPatch = '@@ -3,1 +3,2 @@\n-old\n+new\n+extra\n@@ -5 +6 @@\n context';
    const findings: InlineReviewComment[] = [
      { ...comment, line: 4, side: 'LEFT' },
      { ...comment, line: 5, side: 'RIGHT' },
      { ...comment, line: 6, start_line: 3, start_side: 'RIGHT' },
    ];
    const fetcher = setup([{ filename: comment.path, patch: specificPatch }]);
    await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: findings }, fetcher);
    expect(payload(fetcher).comments).toBeUndefined();
    expect(payload(fetcher).body.match(/Could not safely anchor/g)).toHaveLength(3);
  });

  it('preserves unanchorable findings in summary and converts suggestion fences', async () => {
    const missing = { ...comment, path: 'absent.ts' };
    const fetcher = setup();
    await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment, missing] }, fetcher);
    const posted = payload(fetcher);
    expect(posted.comments).toEqual([comment]);
    expect(posted.body).toContain('## Findings retained in summary');
    expect(posted.body).toContain('absent.ts:11 (RIGHT)');
    expect(posted.body).toContain('```\nreturn input?.value;\n```');
    expect(posted.body).not.toContain('```suggestion');
  });

  it.each([undefined, null, '@@ -10,4 +10,4 @@\n context\n-old\n+new', 'malformed patch'])('retains unavailable or truncated patches in summary: %s', patchValue => {
    const fetcher = setup([{ filename: comment.path, patch: patchValue }]);
    return publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher).then(result => {
      expect(result).toEqual({ ok: true });
      expect(payload(fetcher).comments).toBeUndefined();
      expect(payload(fetcher).body).toContain('Could not safely anchor');
    });
  });

  it('caps inline comments at 100 and preserves overflow', async () => {
    const fetcher = setup();
    const comments = Array.from({ length: 102 }, (_, i) => ({ ...comment, body: `Finding ${i}` }));
    await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments }, fetcher);
    expect(payload(fetcher).comments).toHaveLength(100);
    expect(payload(fetcher).body).toContain('Finding 100');
    expect(payload(fetcher).body).toContain('Finding 101');
  });

  it('fetches additional pages before validating anchors', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(detail(101)))
      .mockResolvedValueOnce(json(Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}.ts`, patch }))))
      .mockResolvedValueOnce(json([{ filename: comment.path, patch }] ))
      .mockResolvedValueOnce(json(detail(101)))
      .mockResolvedValueOnce(json({ id: 10 }));
    expect(await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher)).toEqual({ ok: true });
    expect(fetcher.mock.calls[2]?.[0]).toContain('page=2');
    expect(payload(fetcher).comments).toEqual([comment]);
  });

  it('fails safely when the PR head moved before or during diff retrieval', async () => {
    for (const movedDuringFetch of [false, true]) {
      const fetcher = movedDuringFetch
        ? vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail())).mockResolvedValueOnce(json([{ filename: comment.path, patch }])).mockResolvedValueOnce(json(detail(1, 'b'.repeat(40))))
        : vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail(1, 'b'.repeat(40))));
      expect(await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher)).toMatchObject({ ok: false, error: expect.stringContaining('head changed') });
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    }
  });

  it.each([null, {}, { head: null }, { head: { sha }, changed_files: '1' }])('rejects malformed PR metadata: %j', metadata => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(metadata));
    return publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher).then(result => {
      expect(result.ok).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it.each([null, {}, [], [null], [{ filename: comment.path, patch: 1 }], [{ filename: '../outside.ts' }]])('rejects malformed or incomplete file metadata: %j', files => {
    const fetcher = setup(files);
    return publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher).then(result => {
      expect(result.ok).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('requires pinned findings and safe repository input before network calls', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await publishInlineReview(github, 'owner/repo', 42, 'Summary', { comments: [comment] }, fetcher)).ok).toBe(false);
    expect((await publishInlineReview(github, '../outside', 42, 'Summary', { comments: [] }, fetcher)).ok).toBe(false);
    expect((await publishInlineReview(github, 'owner/repo', 0, 'Summary', { comments: [] }, fetcher)).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops on a short non-final page instead of chasing incomplete file results', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(detail(101)))
      .mockResolvedValueOnce(json([{ filename: comment.path, patch }]));
    expect(await publishInlineReview(github, 'owner/repo', 42, 'Summary', { headSha: sha, comments: [comment] }, fetcher)).toMatchObject({ ok: false, error: expect.stringContaining('incomplete') });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('supports legacy summary-only reviews without diff lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 10 }));
    expect(await publishInlineReview(github, 'owner/repo', 42, 'Summary', { comments: [] }, fetcher)).toEqual({ ok: true });
    expect(payload(fetcher)).toEqual({ body: 'Summary', event: 'COMMENT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'http', 'malformed'])('never retries or falls back after a posting failure: %s', async failure => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('Network timeout'));
    else if (failure === 'http') fetcher.mockResolvedValueOnce(json({ message: 'Invalid anchor' }, 422));
    else fetcher.mockResolvedValueOnce(json({}));
    const result = await publishInlineReview(github, 'owner/repo', 42, 'Summary', { comments: [] }, fetcher);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('check GitHub before retrying') });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
