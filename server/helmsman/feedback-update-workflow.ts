import { createHash } from 'node:crypto';
import type { FeedbackOutcome } from '../../src/logic/feedbackOutcome';
import { feedbackAuditOutcome, parseFeedbackAudit, type FeedbackAudit } from './feedback-audit';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';

export interface FeedbackDecision {
  sourceUrl: string;
  question: string;
}

export interface FeedbackUpdateOptions {
  maxRounds: number;
  collect(): Promise<FeedbackSnapshot>;
  author(snapshot: FeedbackSnapshot, feedback: string, round: number): Promise<void>;
  audit(snapshot: FeedbackSnapshot, round: number, decisions: string): Promise<unknown[]>;
  decide(decisions: FeedbackDecision[]): Promise<string>;
  outcome(outcome: FeedbackOutcome): void;
  assertRevision(snapshot: FeedbackSnapshot): Promise<void>;
  isStopped(): boolean;
}

function repairFeedback(reports: FeedbackAudit[]): string {
  return reports.map(report => JSON.stringify({ summary: report.summary, coverage: report.coverage, findings: report.findings })).join('\n\n');
}

export async function runFeedbackUpdateWorkflow(options: FeedbackUpdateOptions): Promise<void> {
  if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 5) throw new Error('Invalid feedback review round limit');
  let snapshot = await options.collect();
  const initial = snapshot;
  const check = async (value: FeedbackSnapshot) => {
    if (options.isStopped()) throw new Error('Feedback update stopped');
    if (value.repo !== initial.repo || value.prNumber !== initial.prNumber || value.state !== 'OPEN'
      || value.headBranch !== initial.headBranch || value.baseBranch !== initial.baseBranch) {
      throw new Error('PR identity, branch, or open state changed during feedback update');
    }
    await options.assertRevision(value);
  };
  let feedback = '';
  let humanAnswers = '';
  let repairAttempts = 0;
  let decisionRounds = 0;
  const answeredQuestions = new Set<string>();
  let lastSummary = 'Feedback verification has not completed.';
  try {
    await check(snapshot);
    options.outcome({ state: 'changes_remaining', headSha: snapshot.headSha, summary: lastSummary });
    for (let round = 1; repairAttempts < options.maxRounds; round++) {
      if (options.isStopped()) throw new Error('Feedback update stopped');
      await options.author(snapshot, feedback + (humanAnswers ? `\n\nHuman clarification answers (apply only within their stated authority):\n${humanAnswers}` : ''), round);
      snapshot = await options.collect();
      await check(snapshot);
      options.outcome({ state: 'changes_remaining', headSha: snapshot.headSha, summary: 'Independently checking the published revision and every feedback source.' });
      const values = await options.audit(snapshot, round, humanAnswers);
      if (!Array.isArray(values) || values.length === 0) throw new Error('Independent feedback review did not produce a report');
      const reports = values.map(value => parseFeedbackAudit(value, snapshot, humanAnswers ? createHash('sha256').update(humanAnswers).digest('hex') : undefined));
      const latest = await options.collect();
      await check(latest);
      if (latest.fingerprint !== snapshot.fingerprint) {
        repairAttempts++;
        snapshot = latest;
        feedback = 'The PR or discussion changed during independent review. Read the latest snapshot and address new or edited findings before re-verification.';
        lastSummary = 'New or edited feedback arrived during review; the earlier assessment is stale.';
        options.outcome({ state: 'changes_remaining', headSha: latest.headSha, summary: lastSummary });
        continue;
      }
      if (reports.every(report => feedbackAuditOutcome(report) === 'completed')) {
        options.outcome({ state: 'completed', headSha: snapshot.headSha, summary: 'Independent review verified the current PR revision, every feedback source, and published responses. No required findings or decisions remain.' });
        return;
      }
      feedback = repairFeedback(reports);
      const decisions = new Map<string, FeedbackDecision>();
      for (const report of reports) {
        for (const coverage of report.coverage) {
          const source = snapshot.sources.find(item => item.id === coverage.sourceId);
          for (const finding of coverage.findings) {
            if (finding.disposition === 'decision_required' && finding.question && source) {
              const key = finding.question.trim().replace(/\s+/g, ' ').toLowerCase();
              if (!decisions.has(key)) decisions.set(key, { sourceUrl: source.url, question: finding.question });
            }
          }
        }
      }
      if (decisions.size > 0) {
        if (++decisionRounds > options.maxRounds || [...decisions.keys()].some(question => answeredQuestions.has(question))) {
          throw new Error('Required feedback decision remains unresolved after clarification; further owner evidence is needed.');
        }
        lastSummary = 'Required feedback decisions are waiting in Clarifications; the run remains active.';
        options.outcome({ state: 'awaiting_decision', headSha: snapshot.headSha, summary: lastSummary });
        const answers = await options.decide([...decisions.values()]);
        if (!answers.trim()) throw new Error('Required feedback decision returned no answer');
        humanAnswers += `${humanAnswers ? '\n\n' : ''}${answers}`;
        decisions.forEach((_, key) => answeredQuestions.add(key));
        snapshot = await options.collect();
        await check(snapshot);
        lastSummary = 'Required decisions were answered; their implementation and response still need independent verification.';
      } else {
        repairAttempts++;
        lastSummary = 'Independent review found unresolved feedback or missing response evidence.';
      }
      options.outcome({ state: 'changes_remaining', headSha: snapshot.headSha, summary: lastSummary });
    }
    throw new Error(`Feedback remains after ${options.maxRounds} review rounds. ${lastSummary}`);
  } catch (error) {
    options.outcome({ state: 'changes_remaining', headSha: snapshot.headSha,
      summary: (error instanceof Error ? error.message : 'Feedback verification failed').slice(0, 4000) });
    throw error;
  }
}
