import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunArtifactStore } from './artifacts';
import { createFeedbackDiagnosticsReader } from './feedback-diagnostics';
import type { FeedbackAudit, FeedbackDispositionFinding } from './feedback-audit';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';
import type { RunRow } from './db';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const row = { id: 'run-1', repo: 'owner/repo', prNumber: 42, status: 'failed' } as RunRow;
const headSha = 'a'.repeat(40);
const responseUrl = 'https://github.com/owner/repo/pull/42#issuecomment-12';
const snapshot: FeedbackSnapshot = {
  repo: row.repo, prNumber: 42, headSha, baseSha: 'b'.repeat(40), baseBranch: 'main', headBranch: 'fix/issue', state: 'OPEN', fingerprint: 'snapshot-1',
  sources: [{ id: 'comment:12', url: responseUrl, body: 'Fixed.', kind: 'comment', updatedAt: '2026-10-01T00:00:00Z' }],
};
function audit(findings: FeedbackDispositionFinding[] = []): FeedbackAudit {
  return { headSha, snapshotFingerprint: snapshot.fingerprint, summary: 'Review finished.', coverage: [{ sourceId: 'comment:12', findings }],
    findings: [{ title: 'Tests could not execute', body: 'The reviewer checkout is missing node_modules/.bin/vitest.' }] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-feedback-diagnostics-'));
  directories.push(root);
  const artifacts = createRunArtifactStore(join(root, '.artifacts'));
  return { root, artifacts, read: createFeedbackDiagnosticsReader(root),
    write: async (round: number, report = audit(), reviewer = 'codex', runId = row.id, captured = snapshot) => {
      await artifacts.write({ runId, stage: 'feedback-snapshot', round }, JSON.stringify(captured));
      await artifacts.write({ runId, stage: 'feedback-review', round, reviewer }, JSON.stringify(report));
    } };
}

describe('feedback diagnostics', () => {
  it('reads only the newest round for this run and retains the verified reviewer evidence', async () => {
    const env = await fixture();
    await env.write(1, { ...audit(), findings: [{ title: 'Old blocker', body: 'Outdated.' }] });
    await env.write(3);
    await env.write(4, { ...audit(), findings: [{ title: 'Other run', body: 'Unrelated.' }] }, 'codex', 'other-run');
    expect(await env.read(row, headSha)).toEqual({ reviewDiagnostics: { round: 3, headSha,
      blockers: [{ reviewer: 'codex', title: 'Tests could not execute', detail: 'The reviewer checkout is missing node_modules/.bin/vitest.' }] } });
  });

  it('includes completion blockers from both reviewers while omitting resolved findings', async () => {
    const env = await fixture();
    const finding: FeedbackDispositionFinding = { title: 'Resolved', required: true, disposition: 'fixed', evidence: 'Verified.', responseUrl };
    await env.write(2, audit([
      finding,
      { ...finding, title: 'Required deferred', disposition: 'deferred' },
      { ...finding, title: 'Optional deferred', required: false, disposition: 'deferred' },
      { ...finding, title: 'Remaining', required: false, disposition: 'remaining' },
      { ...finding, title: 'Missing reply', responseUrl: undefined },
      { ...finding, title: 'Security decision', disposition: 'decision_required', question: 'Accept historical SVG risk?' },
    ]));
    await env.write(2, audit(), 'claude-code');
    const result = await env.read(row, headSha);
    expect(result.reviewDiagnostics?.blockers.map(blocker => blocker.title)).toEqual([
      'Tests could not execute', 'Required deferred', 'Remaining', 'Missing reply', 'Security decision', 'Tests could not execute',
    ]);
    expect(result.reviewDiagnostics?.blockers.at(-1)?.reviewer).toBe('claude-code');
    expect(result.reviewDiagnostics?.blockers.find(blocker => blocker.title === 'Security decision')?.detail).toContain('Accept historical SVG risk?');
  });

  it('bounds the number and detail length of blockers', async () => {
    const env = await fixture();
    await env.write(1, { ...audit(Array.from({ length: 15 }, (_, index) => ({ title: `Blocker ${index}`, required: true, disposition: 'remaining', evidence: 'x'.repeat(8000) }))), findings: [] });
    const result = await env.read(row, headSha);
    expect(result.reviewDiagnostics?.blockers).toHaveLength(10);
    expect(result.reviewDiagnostics?.blockers[0]?.detail).toHaveLength(4000);
  });

  it.each(['running', 'succeeded'] as const)('omits review evidence on %s runs', async status => {
    const env = await fixture();
    await env.write(1);
    expect(await env.read({ ...row, status }, headSha)).toEqual({});
  });

  it('omits legacy runs with no stored reviews', async () => {
    const env = await fixture();
    expect(await env.read(row, headSha)).toEqual({});
    await env.artifacts.write({ runId: row.id, stage: 'feedback-snapshot', round: 1 }, JSON.stringify(snapshot));
    expect(await env.read(row, headSha)).toEqual({});
  });

  it.each(['checksum', 'missing-manifest', 'stale-head', 'other-repo', 'other-pr', 'missing-outcome', 'symlink', 'oversize'])(
    'reports unavailable diagnostics instead of stale or unsafe evidence: %s', async failure => {
      const env = await fixture();
      await env.write(1, audit(), 'codex', row.id, { ...snapshot,
        ...(failure === 'other-repo' ? { repo: 'other/repo' } : {}), ...(failure === 'other-pr' ? { prNumber: 43 } : {}) });
      const path = join(env.root, '.artifacts', row.id, 'feedback-review.1.codex.artifact');
      if (failure === 'checksum') await writeFile(path, '{}');
      if (failure === 'missing-manifest') await rm(`${path}.manifest.json`);
      if (failure === 'oversize') await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
      if (failure === 'symlink') { await rm(path); await symlink(join(env.root, 'elsewhere'), path); }
      expect(await env.read(row, failure === 'missing-outcome' ? undefined : failure === 'stale-head' ? 'c'.repeat(40) : headSha))
        .toEqual({ reviewDiagnosticsError: expect.stringContaining('could not be verified') });
    });
});
