// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAcceptanceBrief, PrePrContext } from './pre-pr-context';
import { parsePrMetadata } from './pre-pr-runtime';
import type { PrePrReview } from './pre-pr-workflow';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const nextSha = 'c'.repeat(40);
const brief = { property: 'Customer can safely navigate imported files.', nonGoals: ['Detect every hostile byte.'],
  boundaries: ['Serving Content-Type'], verification: ['Browser cannot execute script.'], decisions: [] };
const metadata = { title: 'T-1 Fix', body: 'Original PR description', brief };
const review: PrePrReview = { baseSha, headSha, verdict: 'REQUEST_CHANGES', summary: 'Customer property fails.',
  findings: [{ title: 'Missing serving guard', body: 'Browser executes script.', path: 'serve.ts', line: 1 }] };
function context() { return new PrePrContext(baseSha, 'voyage/test', ['codex', 'claude-code']); }

describe('acceptance brief validation', () => {
  it('preserves legacy metadata and captures normalized optional briefs', () => {
    expect(parsePrMetadata({ title: 'T-1 Fix', body: metadata.body })).toEqual({ title: 'T-1 Fix', body: metadata.body });
    expect(parsePrMetadata(metadata).brief).toEqual(brief);
  });
  it.each([null, [], {}, { ...brief, property: 'x'.repeat(1001) }, { ...brief, boundaries: Array(11).fill('Boundary') },
    { ...brief, verification: [null] }, { ...brief, nonGoals: ['x'.repeat(501)] }, { ...brief, decisions: [{ finding: 'F', disposition: 'Fixed' }] },
    { ...brief, decisions: Array(11).fill({ finding: 'F', disposition: 'Fixed', evidence: 'E' }) },
    { ...brief, property: 'Unsafe\0text' }, { ...brief, boundaries: Array(10).fill('x'.repeat(500)), verification: Array(10).fill('x'.repeat(500)) },
  ])('rejects malformed or oversized present brief %#', value => {
    expect(() => parseAcceptanceBrief(value)).toThrow('acceptance brief');
    expect(() => parsePrMetadata({ ...metadata, brief: value })).toThrow();
  });
});

describe('bounded acceptance context', () => {
  it('pins initial scope, carries author decision claims, and keeps same-round peers independent', () => {
    const memory = context();
    memory.captureAuthor(metadata, 0, headSha);
    const first = memory.render(1);
    memory.rememberReview('codex', 1, review);
    expect(memory.render(1)).toBe(first);
    expect(memory.render(2)).not.toContain('Missing serving guard');
    memory.rememberReview('claude-code', 1, { ...review, summary: 'Independent confirmation' });
    expect(memory.render(1)).toBe(first);
    expect(memory.render(2)).toContain('Missing serving guard');
    memory.captureAuthor({ ...metadata, brief: { ...brief, property: 'Author proposed narrower scope',
      decisions: [{ finding: 'Missing serving guard', disposition: 'Fixed', evidence: 'Browser verification at revised head' }] } }, 1, nextSha);
    const next = memory.render(2);
    expect(next).toContain(brief.property);
    expect(next).toContain('Author proposed narrower scope');
    expect(next).toContain('Browser verification at revised head');
    expect(next).toContain('historical verdicts are not approval');
    expect(next).toContain(headSha);
    expect(next).toContain(nextSha);
    memory.captureAuthor(metadata, 2, 'd'.repeat(40));
    expect(memory.render(3)).toContain('Browser verification at revised head');
    expect(memory.render(3)).toContain('author decision and verification claims');
  });

  it('bounds prose and review history with visible omissions without mutating reports', () => {
    const memory = context();
    memory.captureAuthor({ body: 'Legacy details '.repeat(1000) }, 0, headSha);
    for (let round = 1; round <= 5; round++) {
      for (const reviewer of ['codex', 'claude-code']) memory.rememberReview(reviewer, round, { ...review,
        summary: 'Long evidence '.repeat(200), findings: [{ title: 'Missing guard', body: 'Evidence '.repeat(500) }] });
    }
    const rendered = memory.render(6);
    expect(rendered.length).toBeLessThan(24000);
    expect(rendered).toContain('[omitted: context budget');
    expect(rendered).toContain('unstructuredBody');
    expect(review.findings[0]?.body).toBe('Browser executes script.');
  });

  it('restores only the explicit sidecar with matching metadata and revision, preserving original scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helmsman-context-'));
    try {
      const path = join(dir, 'fix-2.json');
      const memory = context();
      memory.captureAuthor(metadata, 0, headSha);
      for (const reviewer of ['codex', 'claude-code']) memory.rememberReview(reviewer, 1, review);
      memory.captureAuthor({ ...metadata, brief: { ...brief, decisions: [{ finding: 'Guard', disposition: 'Fixed', evidence: 'Prior evidence retained across continuation' }] } }, 1, nextSha);
      const finalSha = 'd'.repeat(40);
      memory.captureAuthor(metadata, 2, finalSha);
      await memory.save(path);
      const restored = context();
      await restored.restore(path, metadata, { headSha: finalSha, round: 3 });
      expect(restored.render(3)).toBe(memory.render(3));
      expect(restored.render(3)).toContain('Prior evidence retained across continuation');
      await expect(context().restore(path, metadata, { headSha, round: 3 })).rejects.toThrow('checkpoint');
      await expect(context().restore(path, { ...metadata, brief: { ...brief, property: 'Different property' } }, { headSha: finalSha, round: 3 })).rejects.toThrow('checkpoint');
      const saved = JSON.parse(await readFile(`${path}.context.json`, 'utf8'));
      saved.baseSha = nextSha;
      await writeFile(`${path}.context.json`, JSON.stringify(saved));
      await expect(context().restore(path, metadata, { headSha: finalSha, round: 3 })).rejects.toThrow('provenance');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('falls back only for absent historical sidecars and rejects symlinks and oversized files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helmsman-context-'));
    try {
      const path = join(dir, 'fix-1.json');
      const memory = context();
      await memory.restore(path, { body: 'Historical PR description' }, { headSha, round: 2 });
      expect(memory.render(2)).toContain('Initial acceptance brief unavailable');
      expect(memory.render(2)).toContain('Historical PR description');
      await writeFile(join(dir, 'other'), '{}');
      await symlink(join(dir, 'other'), `${path}.context.json`);
      await expect(context().restore(path, metadata, { headSha, round: 2 })).rejects.toThrow();
      await rm(`${path}.context.json`);
      await writeFile(`${path}.context.json`, ' '.repeat(512 * 1024 + 1));
      await expect(context().restore(path, metadata, { headSha, round: 2 })).rejects.toThrow('context file');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
