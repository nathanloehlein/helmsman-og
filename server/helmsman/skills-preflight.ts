import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { SkillDeclaration } from './workflow-snapshots';

const SAFE_SKILL = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
export const MAX_SKILL_FILES = 1_000;
export const MAX_SKILL_DEPTH = 16;
const READ_CHUNK_BYTES = 64 * 1024;

export interface VerifiedSkill extends SkillDeclaration {
  sourcePath: string;
}

export interface SkillsPreflightInput {
  declarations: readonly SkillDeclaration[];
  trustedNames: ReadonlySet<string>;
  skillsRoot: string;
}

interface HashState {
  files: number;
  bytes: number;
}

function consume(state: HashState, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > MAX_SKILL_BYTES) throw new Error('Skill source exceeds maximum size');
}

async function hashFile(path: string, key: string, hash: ReturnType<typeof createHash>, state: HashState): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Skill source contains an unsupported file');
    state.files += 1;
    if (state.files > MAX_SKILL_FILES) throw new Error('Skill source contains too many files');
    const prefix = Buffer.from(`${key}\0`);
    consume(state, prefix.length);
    hash.update(prefix);
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      consume(state, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const suffix = Buffer.from('\0');
    consume(state, suffix.length);
    hash.update(suffix);
  } finally {
    await handle.close();
  }
}

async function collect(root: string, current: string, depth: number, hash: ReturnType<typeof createHash>, state: HashState): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) throw new Error('Skill source exceeds maximum depth');
  const currentStat = await lstat(current);
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error('Skill source contains an unsafe directory');
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Skill source contains a symbolic link');
    if (stat.isDirectory()) await collect(root, path, depth + 1, hash, state);
    else if (stat.isFile()) {
      const key = relative(root, path).split(sep).join('/');
      await hashFile(path, key, hash, state);
    } else throw new Error('Skill source contains an unsupported file');
  }
}

export async function hashSkillDirectory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill source is not a safe directory');
  const hash = createHash('sha256');
  await collect(path, path, 0, hash, { files: 0, bytes: 0 });
  return hash.digest('hex');
}

export async function preflightSkills(input: SkillsPreflightInput): Promise<VerifiedSkill[]> {
  if (!input || !Array.isArray(input.declarations)) throw new Error('Skill declarations are required');
  const root = resolve(input.skillsRoot);
  const names = new Set<string>();
  const verified: VerifiedSkill[] = [];
  for (const declaration of input.declarations) {
    if (!declaration || !SAFE_SKILL.test(declaration.name) || !input.trustedNames.has(declaration.name)
      || !/^[a-f\d]{64}$/i.test(declaration.contentHash) || names.has(declaration.name)) {
      throw new Error('Skill declaration is not trusted or valid');
    }
    names.add(declaration.name);
    const sourcePath = resolve(root, declaration.name);
    if (relative(root, sourcePath).startsWith(`..${sep}`) || relative(root, sourcePath) === '..') throw new Error('Skill source escaped its root');
    let actual: string;
    try {
      const instruction = await lstat(join(sourcePath, 'SKILL.md'));
      if (!instruction.isFile() || instruction.isSymbolicLink()) throw new Error('missing instruction');
      actual = await hashSkillDirectory(sourcePath);
    } catch { throw new Error(`Required skill ${declaration.name} is unavailable or unsafe`); }
    if (actual !== declaration.contentHash.toLowerCase()) throw new Error(`Required skill ${declaration.name} revision does not match its snapshot`);
    verified.push({ ...declaration, contentHash: actual, sourcePath });
  }
  return verified;
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill install directory is unsafe');
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Skill install destination already exists');
}

export async function installVerifiedSkills(skills: readonly VerifiedSkill[], runDirectory: string): Promise<string[]> {
  const root = resolve(runDirectory);
  await safeDirectory(root);
  const installed: string[] = [];
  for (const skill of skills) {
    if (!skill || !SAFE_SKILL.test(skill.name) || !/^[a-f\d]{64}$/i.test(skill.contentHash)) throw new Error('Verified skill is invalid');
    if (await hashSkillDirectory(skill.sourcePath) !== skill.contentHash) throw new Error(`Required skill ${skill.name} changed before installation`);
    const target = resolve(root, skill.name);
    if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === '..') throw new Error('Skill install escaped its run directory');
    await absent(target);
    try {
      await cp(skill.sourcePath, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
      if (await hashSkillDirectory(target) !== skill.contentHash) throw new Error(`Installed skill ${skill.name} revision does not match its snapshot`);
      installed.push(target);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }
  return installed;
}
