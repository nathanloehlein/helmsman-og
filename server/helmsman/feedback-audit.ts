import type { FeedbackSnapshot } from './pr-feedback-snapshot';

export interface FeedbackDispositionFinding {
  title: string;
  required: boolean;
  disposition: 'fixed' | 'dismissed' | 'deferred' | 'remaining' | 'decision_required';
  evidence: string;
  responseUrl?: string;
  question?: string;
}

export interface FeedbackCoverage {
  sourceId: string;
  findings: FeedbackDispositionFinding[];
}

export interface FeedbackFreshFinding {
  title: string;
  body: string;
  path?: string;
  line?: number;
}

export interface FeedbackAudit {
  headSha: string;
  snapshotFingerprint: string;
  decisionFingerprint?: string;
  summary: string;
  coverage: FeedbackCoverage[];
  findings: FeedbackFreshFinding[];
}

export class FeedbackAuditError extends Error {
  constructor(message: string) {
    super(`Feedback audit: ${message}`);
    this.name = 'FeedbackAuditError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function responseOnPr(raw: string, snapshot: FeedbackSnapshot): boolean {
  try {
    const url = new URL(raw);
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search
      && [`/${snapshot.repo}/pull/${snapshot.prNumber}`, `/${snapshot.repo}/pull/${snapshot.prNumber}/files`]
        .some(path => path.toLowerCase() === url.pathname.toLowerCase())
      && /^#(?:issuecomment-|discussion_r|pullrequestreview-)\d+$/.test(url.hash);
  } catch { return false; }
}

export function parseFeedbackAudit(value: unknown, snapshot: FeedbackSnapshot, decisionFingerprint?: string): FeedbackAudit {
  if (!record(value) || !text(value.headSha, 64) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value.headSha)
    || !text(value.snapshotFingerprint, 256) || !text(value.summary, 8000)
    || !Array.isArray(value.coverage) || !Array.isArray(value.findings) || value.findings.length > 40) {
    throw new FeedbackAuditError('missing or malformed report; completion blocked.');
  }
  if (value.headSha !== snapshot.headSha || value.snapshotFingerprint !== snapshot.fingerprint) {
    throw new FeedbackAuditError('report refers to a stale head or feedback snapshot; completion blocked.');
  }
  if (decisionFingerprint !== undefined && (!text(decisionFingerprint, 256) || value.decisionFingerprint !== decisionFingerprint)
    || decisionFingerprint === undefined && value.decisionFingerprint !== undefined) {
    throw new FeedbackAuditError('report does not match the trusted human-decision transcript; completion blocked.');
  }
  const sources = new Set(snapshot.sources.map(source => source.id));
  if (sources.size !== snapshot.sources.length || value.coverage.length !== sources.size) {
    throw new FeedbackAuditError('coverage must account for every snapshot source exactly once.');
  }
  const responses = new Set(snapshot.sources.filter(source => source.kind !== 'description'
    && !(source.kind === 'review' && (source.state === 'PENDING' || source.submittedAt === null))
    && responseOnPr(source.url, snapshot)).map(source => source.url));
  const seen = new Set<string>();
  let totalFindings = 0;
  const coverage: FeedbackCoverage[] = value.coverage.map((entry: unknown): FeedbackCoverage => {
    if (!record(entry) || !text(entry.sourceId, 1024) || !sources.has(entry.sourceId) || seen.has(entry.sourceId)
      || !Array.isArray(entry.findings) || entry.findings.length > 200) {
      throw new FeedbackAuditError('coverage contains a missing, duplicate, unknown or malformed source.');
    }
    seen.add(entry.sourceId);
    totalFindings += entry.findings.length;
    if (totalFindings > 2000) throw new FeedbackAuditError('report exceeds 2000 source findings; completion blocked.');
    const findings = entry.findings.map((finding: unknown): FeedbackDispositionFinding => {
      if (!record(finding) || !text(finding.title, 180) || typeof finding.required !== 'boolean'
        || typeof finding.disposition !== 'string' || !['fixed', 'dismissed', 'deferred', 'remaining', 'decision_required'].includes(finding.disposition)
        || !text(finding.evidence, 8000)
        || (finding.responseUrl !== undefined && (!text(finding.responseUrl, 2048) || !responses.has(finding.responseUrl)))
        || (finding.question !== undefined && !text(finding.question, 2000))) {
        throw new FeedbackAuditError('source finding or published response reference is malformed.');
      }
      if (finding.disposition === 'decision_required' && (finding.required !== true || !text(finding.question, 2000))) {
        throw new FeedbackAuditError('a required decision needs required:true and a specific question.');
      }
      return { title: finding.title.trim(), required: finding.required,
        disposition: finding.disposition as FeedbackDispositionFinding['disposition'], evidence: finding.evidence.trim(),
        ...(finding.responseUrl !== undefined ? { responseUrl: finding.responseUrl as string } : {}),
        ...(finding.question !== undefined ? { question: (finding.question as string).trim() } : {}) };
    });
    return { sourceId: entry.sourceId, findings };
  });
  const findings: FeedbackFreshFinding[] = value.findings.map((finding: unknown): FeedbackFreshFinding => {
    if (!record(finding) || !text(finding.title, 180) || !text(finding.body, 4000)
      || (finding.path !== undefined && (!text(finding.path, 1024) || /^[\\/]|^[a-z]:|[\r\n\\]/i.test(finding.path)
        || finding.path.split('/').some(part => !part || part === '.' || part === '..')))
      || (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || Number(finding.line) < 1 || !finding.path))) {
      throw new FeedbackAuditError('fresh code finding is malformed.');
    }
    return { title: finding.title.trim(), body: finding.body.trim(),
      ...(finding.path !== undefined ? { path: finding.path as string } : {}),
      ...(finding.line !== undefined ? { line: finding.line as number } : {}) };
  });
  return { headSha: value.headSha, snapshotFingerprint: value.snapshotFingerprint,
    ...(decisionFingerprint !== undefined ? { decisionFingerprint } : {}), summary: value.summary.trim(), coverage, findings };
}

export function feedbackAuditOutcome(audit: FeedbackAudit): 'completed' | 'changes_remaining' | 'awaiting_decision' {
  const findings = audit.coverage.flatMap(entry => entry.findings);
  if (findings.some(finding => finding.disposition === 'decision_required')) return 'awaiting_decision';
  if (audit.findings.length > 0 || findings.some(finding => !finding.responseUrl || finding.disposition === 'remaining'
    || finding.required && finding.disposition === 'deferred')) return 'changes_remaining';
  return 'completed';
}
