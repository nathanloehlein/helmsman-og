import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

export interface RunArtifactIdentity {
  runId: string;
  stage: string;
  round: number;
  reviewer?: string;
}

export interface RunArtifactManifest extends RunArtifactIdentity {
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface RunArtifactStore {
  write(identity: RunArtifactIdentity, content: string | Uint8Array): Promise<RunArtifactManifest>;
  read(identity: RunArtifactIdentity): Promise<Uint8Array>;
  verify(identity: RunArtifactIdentity): Promise<RunArtifactManifest>;
  manifest(identity: RunArtifactIdentity): Promise<RunArtifactManifest>;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function valid(identity: RunArtifactIdentity): boolean {
  return typeof identity?.runId === 'string' && SAFE_ID.test(identity.runId)
    && typeof identity.stage === 'string' && SAFE_ID.test(identity.stage)
    && Number.isSafeInteger(identity.round) && identity.round >= 0 && identity.round <= 10_000
    && (identity.reviewer === undefined || (typeof identity.reviewer === 'string' && SAFE_ID.test(identity.reviewer)));
}

function artifactName(identity: RunArtifactIdentity): string {
  if (!valid(identity)) throw new Error('Invalid run artifact identity');
  return `${identity.stage}.${identity.round}${identity.reviewer ? `.${identity.reviewer}` : ''}`;
}

function paths(root: string, identity: RunArtifactIdentity) {
  const name = artifactName(identity);
  const relativePath = `${identity.runId}/${name}.artifact`;
  const artifact = resolve(root, relativePath);
  const manifest = resolve(root, `${relativePath}.manifest.json`);
  if (relative(root, artifact).startsWith(`..${sep}`) || relative(root, artifact) === '..'
    || relative(root, manifest).startsWith(`..${sep}`) || relative(root, manifest) === '..') {
    throw new Error('Run artifact path escaped its store');
  }
  return { relativePath, artifact, manifest };
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Run artifact directory is unsafe');
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

function parseManifest(value: Uint8Array, identity: RunArtifactIdentity, relativePath: string): RunArtifactManifest {
  let manifest: unknown;
  try { manifest = JSON.parse(Buffer.from(value).toString('utf8')); } catch { throw new Error('Run artifact manifest is malformed'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Run artifact manifest is malformed');
  const record = manifest as Record<string, unknown>;
  if (record.runId !== identity.runId || record.stage !== identity.stage || record.round !== identity.round
    || record.reviewer !== identity.reviewer || record.relativePath !== relativePath
    || typeof record.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(record.sha256)
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new Error('Run artifact manifest does not match its identity');
  return record as unknown as RunArtifactManifest;
}

export function createRunArtifactStore(rootPath: string): RunArtifactStore {
  const root = resolve(rootPath);
  const loadManifest = async (identity: RunArtifactIdentity): Promise<RunArtifactManifest> => {
    const { relativePath, manifest } = paths(root, identity);
    const stat = await lstat(manifest);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Run artifact manifest is unsafe');
    return parseManifest(await readFile(manifest), identity, relativePath);
  };
  const verify = async (identity: RunArtifactIdentity): Promise<RunArtifactManifest> => {
    const { artifact } = paths(root, identity);
    const manifest = await loadManifest(identity);
    const stat = await lstat(artifact);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Run artifact is unsafe');
    const bytes = await readFile(artifact);
    if (bytes.byteLength !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
      throw new Error('Run artifact checksum does not match its manifest');
    }
    return manifest;
  };
  return {
    async write(identity, content) {
      const { relativePath, artifact, manifest: manifestPath } = paths(root, identity);
      const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
      await directory(root);
      const runDirectory = dirname(artifact);
      await directory(runDirectory);
      const output: RunArtifactManifest = { ...identity, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
      try {
        await writeExclusive(artifact, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          const existing = await verify(identity);
          if (existing.sha256 !== output.sha256 || existing.bytes !== output.bytes) throw new Error('Run artifact already exists with different content');
          return existing;
        }
        throw error;
      }
      try {
        await writeExclusive(manifestPath, Buffer.from(JSON.stringify(output)));
      } catch (error) {
        await rm(artifact, { force: true });
        throw error;
      }
      return output;
    },
    manifest: loadManifest,
    async read(identity) {
      await verify(identity);
      const { artifact } = paths(root, identity);
      const stat = await lstat(artifact);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Run artifact is unsafe');
      return readFile(artifact);
    },
    verify,
  };
}
