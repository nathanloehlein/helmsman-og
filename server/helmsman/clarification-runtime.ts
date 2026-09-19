import { lstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseClarificationQuestionLine, type ClarificationStore } from './clarifications';

export function clarificationPaths(runsDir: string, runId: string) {
  if (!/^[a-z\d_-]{1,128}$/i.test(runId)) throw new Error('Invalid clarification run ID');
  return { questionsPath: join(runsDir, `${runId}.clarifications.jsonl`), answersPath: join(runsDir, `${runId}.clarification-answers.jsonl`) };
}

export function createClarificationRuntime(store: ClarificationStore, runsDir: string) {
  const lastOutput = new Map<string, string>();
  return {
    poll(runId: string) {
      const paths = clarificationPaths(runsDir, runId);
      let data = '';
      try {
        const stat = lstatSync(paths.questionsPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid clarification question file');
        data = readFileSync(paths.questionsPath, 'utf8');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const lines = data.slice(0, data.lastIndexOf('\n') + 1).split('\n').filter(line => line.trim());
      for (const line of lines) store.ingestQuestion(runId, parseClarificationQuestionLine(line));
      store.timeoutDue();
      const answers = store.listForRun(runId).filter(question => question.state !== 'pending').map(question => ({
        kind: 'answer', id: question.id, state: question.state, answer: question.answer, answeredAt: question.answeredAt,
      })).map(record => JSON.stringify(record)).join('\n');
      if (answers && lastOutput.get(runId) !== answers) {
        const temporary = `${paths.answersPath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${answers}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, paths.answersPath);
        lastOutput.set(runId, answers);
      }
      if (store.hasRequiredTimedOut(runId)) throw new Error('Required clarification timed out without an answer');
    },
    hasUnanswered: (runId: string) => store.hasRequiredUnanswered(runId),
    complete(runId: string) { store.cancelForRun(runId); lastOutput.delete(runId); },
  };
}
