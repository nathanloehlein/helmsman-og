import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunArtifactStore } from './artifacts';

const directories: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-artifacts-'));
  directories.push(root);
  return { root, store: createRunArtifactStore(root) };
}
const identity = { runId: 'run_1', stage: 'review', round: 2, reviewer: 'codex' };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('run artifacts', () => {
  it('writes an immutable identity-bound manifest and verifies it before reading', async () => {
    const { store: artifacts } = await store();
    const manifest = await artifacts.write(identity, 'report');
    expect(manifest).toMatchObject({ ...identity, relativePath: 'run_1/review.2.codex.artifact', bytes: 6, sha256: expect.stringMatching(/^[a-f\d]{64}$/) });
    expect(Buffer.from(await artifacts.read(identity)).toString()).toBe('report');
    await expect(artifacts.write(identity, 'report')).resolves.toEqual(manifest);
    await expect(artifacts.write(identity, 'replacement')).rejects.toThrow('already exists');
  });

  it('rejects altered content and malformed identities', async () => {
    const { root, store: artifacts } = await store();
    await artifacts.write(identity, 'report');
    await writeFile(join(root, 'run_1', 'review.2.codex.artifact'), 'change');
    await expect(artifacts.verify(identity)).rejects.toThrow('checksum');
    await expect(artifacts.write(identity, 'report')).rejects.toThrow('checksum');
    await expect(artifacts.write({ ...identity, runId: '../outside' }, 'x')).rejects.toThrow('Invalid');
  });

  it('rejects symlinked artifact and manifest paths', async () => {
    const { root, store: artifacts } = await store();
    await artifacts.write(identity, 'report');
    const artifact = join(root, 'run_1', 'review.2.codex.artifact');
    const outside = join(root, 'outside');
    await writeFile(outside, 'outside');
    await rm(artifact);
    await symlink(outside, artifact);
    await expect(artifacts.read(identity)).rejects.toThrow('unsafe');
  });
});
