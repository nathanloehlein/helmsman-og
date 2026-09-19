// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canCreateFileSymlink } from '../test-support/platform';
import { readReviewArtifact } from './review-artifacts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'review-artifact-'));
  roots.push(root);
  return root;
}

describe('review artifact reads', () => {
  it('returns null for missing files and reads regular markdown and JSON unchanged', async () => {
    const root = await directory();
    expect(await readReviewArtifact(root, '.agent-review.md')).toBeNull();
    await writeFile(join(root, '.agent-review.md'), 'Verdict: APPROVE — verified\n');
    await writeFile(join(root, '.agent-review-comments.json'), '[]');
    expect(await readReviewArtifact(root, '.agent-review.md')).toBe('Verdict: APPROVE — verified\n');
    expect(await readReviewArtifact(root, '.agent-review-comments.json')).toBe('[]');
  });

  it.each(['.agent-review.md', '.agent-review-comments.json'] as const)('rejects directories and oversized %s files', async name => {
    const root = await directory();
    const path = join(root, name);
    await mkdir(path);
    await expect(readReviewArtifact(root, name)).rejects.toThrow('regular file');
    await rm(path, { recursive: true });
    await writeFile(path, 'x'.repeat(256 * 1024 + 1));
    await expect(readReviewArtifact(root, name)).rejects.toThrow('256 KB');
    await writeFile(path, 'x'.repeat(256 * 1024));
    expect((await readReviewArtifact(root, name))?.length).toBe(256 * 1024);
  });

  it.skipIf(!canCreateFileSymlink()).each(['.agent-review.md', '.agent-review-comments.json'] as const)('rejects %s symlinks to host files', async name => {
    const root = await directory();
    const outside = join(root, 'private');
    await writeFile(outside, 'private contents');
    await symlink(outside, join(root, name));
    await expect(readReviewArtifact(root, name)).rejects.toThrow();
  });

  it.skipIf(!canCreateFileSymlink())('rejects a replaced worktree directory', async () => {
    const root = await directory();
    const worktree = join(root, 'worktree');
    await writeFile(join(root, '.agent-review.md'), 'outside review');
    await symlink(root, worktree);
    await expect(readReviewArtifact(worktree, '.agent-review.md')).rejects.toThrow('unsafe');
  });
});
