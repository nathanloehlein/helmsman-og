import { describe, expect, it, vi } from 'vitest';
import { classifyReview, fetchReviewHead, fetchReviewScope, selectReviewModel, type ReviewScope } from './review-policy';

function scope(files = 2, lines = 50): ReviewScope {
  return { files: Array.from({ length: files }, (_, i) => ({ filename: `src/components/file${i}.ts`, changes: lines / files, patch: '+const label = "changed";' })), changedFiles: files, changedLines: lines, complete: true, headSha: 'a'.repeat(40) };
}

describe('review complexity selection', () => {
  it('defaults to low even for large changes within one area', () => {
    expect(selectReviewModel(scope(), 'codex')).toMatchObject({ complexity: 'low', model: 'gpt-5.6-terra', effort: 'low' });
    expect(selectReviewModel(scope(3, 700), 'codex')).toMatchObject({ complexity: 'low', model: 'gpt-5.6-terra', effort: 'low' });
    expect(selectReviewModel(scope(16, 2000), 'codex')).toMatchObject({ complexity: 'low', effort: 'low' });
  });

  it('uses medium for larger changes across multiple areas without automatically using high', () => {
    const input = scope(6, 350);
    input.files[0].filename = 'server/api/handler.ts';
    expect(selectReviewModel(input, 'codex')).toMatchObject({ complexity: 'medium', model: 'gpt-5.6-sol', effort: 'medium' });
    const broad = scope(30, 5000);
    broad.files.forEach((file, i) => { file.filename = `packages/area${i}/schema.ts`; });
    expect(selectReviewModel(broad, 'codex')).toMatchObject({ complexity: 'medium', effort: 'medium' });
  });

  it('keeps small multi-area changes low', () => {
    const input = scope(3, 100);
    input.files[0].filename = 'server/api/handler.ts';
    expect(classifyReview(input).complexity).toBe('low');
  });

  it.each(['server/auth.ts', 'db/migrations/003.sql', 'src/payments/provider.ts', 'server/slack/queue.ts'])('does not escalate based on the path %s alone', (filename) => {
    const input = scope(1, 2);
    input.files[0].filename = filename;
    input.files[0].patch = '+await Promise.all(tasks);';
    expect(classifyReview(input).complexity).toBe('low');
  });

  it('uses the default for unavailable scope instead of escalating cost', () => {
    expect(classifyReview(null).complexity).toBe('low');
    expect(classifyReview({ ...scope(), complete: false }).complexity).toBe('low');
  });

  it('supports provider-specific selection and explicit overrides', () => {
    expect(selectReviewModel(scope(), 'claude-code')).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(selectReviewModel(null, 'claude-code')).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(selectReviewModel(scope(), 'codex', { model: 'gpt-6-astra', effort: 'high' })).toMatchObject({ complexity: 'low', model: 'gpt-6-astra', effort: 'high' });
    expect(selectReviewModel(scope(), 'command').model).toBeUndefined();
  });
});

describe('GitHub diff scope', () => {
  const github = { token: 'test', repo: 'o/r', author: 'user' };
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const detail = (changedFiles: number) => ({ head: { sha: 'a'.repeat(40) }, changed_files: changedFiles, additions: 20, deletions: 10 });

  it('fetches bounded, validated review head metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ head: { sha: 'a'.repeat(40), ref: 'feature' }, state: 'open', draft: false, merged: false }));
    expect(await fetchReviewHead(github, 'o/r', 1, fetcher)).toMatchObject({ number: 1, state: 'open', headRefName: 'feature' });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(json({ head: null }));
    expect(await fetchReviewHead(github, 'o/r', 1, malformed)).toBeNull();
  });

  it('requires complete file counts and usable patches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail(1))).mockResolvedValueOnce(json([{ filename: 'src/a.ts', changes: 30, patch: '+let x;' }])).mockResolvedValueOnce(json(detail(1)));
    const result = await fetchReviewScope(github, 'o/r', 1, fetcher);
    expect(result).toMatchObject({ changedFiles: 1, changedLines: 30, complete: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(selectReviewModel(result, 'codex').complexity).toBe('low');
  });

  it('keeps truncated, binary or failed file listings at the default effort', async () => {
    for (const files of [[], [{ filename: 'src/a.ts', changes: 30 }], [{ filename: 'image.png', changes: 0 }], [{ filename: 'src/a.ts' }], [null]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail(1))).mockResolvedValueOnce(json(files)).mockResolvedValueOnce(json(detail(1)));
      expect(selectReviewModel(await fetchReviewScope(github, 'o/r', 1, fetcher), 'codex').complexity).toBe('low');
    }
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail(1))).mockResolvedValueOnce(new Response('', { status: 503 }));
    expect((await fetchReviewScope(github, 'o/r', 1, failed))?.complete).toBe(false);
  });

  it('rejects scope collected across a new push', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(detail(1)))
      .mockResolvedValueOnce(json([{ filename: 'src/a.ts', changes: 30, patch: '+let x;' }]))
      .mockResolvedValueOnce(json({ ...detail(1), head: { sha: 'b'.repeat(40) } }));
    expect(await fetchReviewScope(github, 'o/r', 1, fetcher)).toBeNull();
  });

  it('bounds large diff fetches and rejects malformed external metadata', async () => {
    const large = vi.fn<typeof fetch>().mockResolvedValue(json(detail(301)));
    expect((await fetchReviewScope(github, 'o/r', 1, large))?.complete).toBe(false);
    expect(large).toHaveBeenCalledTimes(1);
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(json({ head: null, changed_files: 1 }));
    expect(await fetchReviewScope(github, 'o/r', 1, invalid)).toBeNull();
    expect(await fetchReviewScope(github, '../outside', 1, invalid)).toBeNull();
  });
});
