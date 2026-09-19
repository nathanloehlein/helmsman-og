import { lstat, mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashSkillDirectory, installVerifiedSkills, MAX_SKILL_BYTES, MAX_SKILL_FILES, preflightSkills } from './skills-preflight';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-skills-'));
  roots.push(root);
  const source = join(root, 'skills', 'review-agent');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '# Review agent\n');
  await writeFile(join(source, 'rules.txt'), 'read-only\n');
  const contentHash = await hashSkillDirectory(source);
  return { root, source, declaration: { name: 'review-agent', contentHash } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('skills preflight', () => {
  it('verifies trusted pinned local skills and installs only into a run directory', async () => {
    const { root, declaration } = await fixture();
    const skills = await preflightSkills({ declarations: [declaration], trustedNames: new Set(['review-agent']), skillsRoot: join(root, 'skills') });
    const installed = await installVerifiedSkills(skills, join(root, 'run', 'skills'));
    expect(installed).toEqual([join(root, 'run', 'skills', 'review-agent')]);
    expect(await hashSkillDirectory(installed[0]!)).toBe(declaration.contentHash);
  });

  it('fails actionable on absent, untrusted, changed, or symlinked sources', async () => {
    const { root, source, declaration } = await fixture();
    const input = { declarations: [declaration], trustedNames: new Set(['other']), skillsRoot: join(root, 'skills') };
    await expect(preflightSkills(input)).rejects.toThrow('not trusted');
    await expect(preflightSkills({ ...input, trustedNames: new Set(['review-agent']), declarations: [{ ...declaration, contentHash: 'b'.repeat(64) }] })).rejects.toThrow('revision');
    await symlink(join(source, 'SKILL.md'), join(source, 'linked'));
    await expect(preflightSkills({ ...input, trustedNames: new Set(['review-agent']) })).rejects.toThrow('unavailable or unsafe');
  });

  it('rechecks the source revision before argv-only installation', async () => {
    const { root, source, declaration } = await fixture();
    const skills = await preflightSkills({ declarations: [declaration], trustedNames: new Set(['review-agent']), skillsRoot: join(root, 'skills') });
    await writeFile(join(source, 'SKILL.md'), 'changed');
    await expect(installVerifiedSkills(skills, join(root, 'run'))).rejects.toThrow('changed before installation');
  });

  it('refuses to merge into an existing per-run skill destination', async () => {
    const { root, declaration } = await fixture();
    const skills = await preflightSkills({ declarations: [declaration], trustedNames: new Set(['review-agent']), skillsRoot: join(root, 'skills') });
    await mkdir(join(root, 'run', 'review-agent'), { recursive: true });
    await expect(installVerifiedSkills(skills, join(root, 'run'))).rejects.toThrow('destination already exists');
  });

  it('enforces bounded skill contents and file counts', async () => {
    const { source } = await fixture();
    await writeFile(join(source, 'large.txt'), Buffer.alloc(MAX_SKILL_BYTES));
    await expect(hashSkillDirectory(source)).rejects.toThrow('maximum size');

    const { source: manyFiles } = await fixture();
    for (let index = 0; index < MAX_SKILL_FILES; index += 1) await writeFile(join(manyFiles, `file-${index}`), 'x');
    await expect(hashSkillDirectory(manyFiles)).rejects.toThrow('too many files');
  });

  it('rejects a symlink copied into a verified install destination and cleans it up', async () => {
    const { root, declaration } = await fixture();
    const skills = await preflightSkills({ declarations: [declaration], trustedNames: new Set(['review-agent']), skillsRoot: join(root, 'skills') });
    await symlink(join(root, 'outside'), join(skills[0]!.sourcePath, 'late-link'));
    const target = join(root, 'run', 'review-agent');
    await expect(installVerifiedSkills(skills, join(root, 'run'))).rejects.toThrow('symbolic link');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
