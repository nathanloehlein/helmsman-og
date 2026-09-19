import type { AgentEvent, AgentTask } from './agents/adapter';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodeAdapter } from './agents/claude-code';
import { codexAdapter } from './agents/codex';
import { assertClarificationReady, executePrePrStage, stageEventEmitter } from './pre-pr-runtime';
import { sanitizeDockerGit } from './docker-stage';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
const abort = new AbortController();
const stop = () => abort.abort();
const clearOutputs = () => Promise.all(['.agent-review.md', '.agent-review-comments.json'].map(name => rm(join(process.cwd(), name), { force: true })));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('SIGHUP', stop);
try {
  const input = JSON.parse(process.argv[2] ?? 'null') as { task?: AgentTask; reviewerId?: string } | null;
  const task = input?.task;
  if (!task?.review || !task.dockerExecution || !['codex', 'claude-code'].includes(input?.reviewerId ?? '')) throw new Error('Invalid Docker review task');
  const adapter = input?.reviewerId === 'claude-code' ? claudeCodeAdapter : codexAdapter;
  const forward = stageEventEmitter(input?.reviewerId === 'claude-code' ? 'claude-code' : 'codex', task, emit);
  await clearOutputs();
  await sanitizeDockerGit(process.cwd(), task.repo);
  forward({ kind: 'phase', text: 'Starting isolated review' });
  await executePrePrStage(adapter, task, process.cwd(), forward, abort.signal);
  await assertClarificationReady(task, task.dockerExecution.runId);
} catch (error) {
  await clearOutputs().catch(() => undefined);
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error), stage: 'review', round: 1 });
  process.exitCode = 1;
} finally {
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
  process.off('SIGHUP', stop);
}
