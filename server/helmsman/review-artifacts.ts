import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export async function readReviewArtifact(worktreePath: string, name: '.agent-review.md' | '.agent-review-comments.json'): Promise<string | null> {
  const limit = 256 * 1024;
  try {
    const directory = await lstat(worktreePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Review artifact directory is unsafe');
    const file = await open(join(worktreePath, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error('Review artifact must be a regular file of at most 256 KB');
      const bytes = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > limit) throw new Error('Review artifact exceeds 256 KB');
      return bytes.subarray(0, size).toString('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}
