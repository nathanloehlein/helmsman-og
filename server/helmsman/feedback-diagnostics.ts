import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunArtifactStore, type RunArtifactIdentity } from './artifacts';
import { parseFeedbackAudit } from './feedback-audit';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';
import type { RunRow } from './db';

export interface ReviewDiagnosticsResult {
  reviewDiagnostics?: { round: number; headSha: string; blockers: Array<{ reviewer: string; title: string; detail: string }> };
  reviewDiagnosticsError?: string;
}

export const REVIEW_DIAGNOSTICS_ERROR = 'Review diagnostics could not be verified. Check the run logs and stored review artifacts.';
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export function createFeedbackDiagnosticsReader(runsDir: string) {
  const root = join(runsDir, '.artifacts');
  const store = createRunArtifactStore(root);
  const read = async (identity: RunArtifactIdentity): Promise<unknown> => {
    const path = join(root, identity.runId, `${identity.stage}.${identity.round}${identity.reviewer ? `.${identity.reviewer}` : ''}.artifact`);
    for (const [file, limit] of [[path, MAX_ARTIFACT_BYTES], [`${path}.manifest.json`, 16 * 1024]] as const) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Unsafe or oversized review artifact');
    }
    const manifest = await store.manifest(identity);
    if (manifest.bytes > MAX_ARTIFACT_BYTES) throw new Error('Oversized review artifact manifest');
    return JSON.parse(Buffer.from(await store.read(identity)).toString('utf8')) as unknown;
  };
  return async (run: RunRow, headSha?: string): Promise<ReviewDiagnosticsResult> => {
    if (run.status !== 'failed' && run.status !== 'stopped') return {};
    try {
      if (!/^[a-z\d_-]{1,128}$/i.test(run.id)) throw new Error('Invalid run identity');
      const directory = join(root, run.id);
      try {
        for (const path of [root, directory]) {
          const stat = await lstat(path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe artifact directory');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
        throw error;
      }
      const reviews: Array<{ round: number; reviewer: string }> = [];
      let entries = 0;
      for await (const entry of await opendir(directory)) {
        if (++entries > 512) throw new Error('Too many review artifacts');
        const match = /^feedback-review\.([1-9]\d{0,3})\.(codex|claude-code)\.artifact(?:\.manifest\.json)?$/.exec(entry.name);
        if (match) reviews.push({ round: Number(match[1]), reviewer: match[2]! });
      }
      if (!reviews.length) return {};
      const round = Math.max(...reviews.map(review => review.round));
      const snapshot = await read({ runId: run.id, stage: 'feedback-snapshot', round }) as FeedbackSnapshot;
      if (!snapshot || typeof snapshot.repo !== 'string' || snapshot.repo.toLowerCase() !== run.repo.toLowerCase()
        || snapshot.prNumber !== run.prNumber || !headSha || snapshot.headSha !== headSha) throw new Error('Stale feedback snapshot');
      const blockers: NonNullable<ReviewDiagnosticsResult['reviewDiagnostics']>['blockers'] = [];
      for (const reviewer of ['codex', 'claude-code']) {
        if (!reviews.some(review => review.round === round && review.reviewer === reviewer)) continue;
        const raw = await read({ runId: run.id, stage: 'feedback-review', round, reviewer });
        const decisionFingerprint = raw && typeof raw === 'object' && 'decisionFingerprint' in raw ? raw.decisionFingerprint : undefined;
        const audit = parseFeedbackAudit(raw, snapshot, typeof decisionFingerprint === 'string' ? decisionFingerprint : undefined);
        for (const finding of audit.findings) blockers.push({ reviewer, title: finding.title.slice(0, 180), detail: finding.body.slice(0, 4000) });
        for (const finding of audit.coverage.flatMap(entry => entry.findings)) {
          if (finding.responseUrl && finding.disposition !== 'remaining' && finding.disposition !== 'decision_required'
            && !(finding.required && finding.disposition === 'deferred')) continue;
          const detail = [finding.evidence, finding.question, !finding.responseUrl ? 'No published response was verified.' : undefined].filter(Boolean).join('\n\n');
          blockers.push({ reviewer, title: finding.title.slice(0, 180), detail: detail.slice(0, 4000) });
        }
      }
      return { reviewDiagnostics: { round, headSha, blockers: blockers.slice(0, 10) } };
    } catch {
      return { reviewDiagnosticsError: REVIEW_DIAGNOSTICS_ERROR };
    }
  };
}
