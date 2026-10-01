import type { AgentEvent } from './agents/adapter';
import { runFeedbackUpdateRuntime } from './feedback-update-runtime';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
try {
  const serialized = process.argv[2];
  if (!serialized) throw new Error('Feedback worker input is required');
  const input = JSON.parse(serialized) as Parameters<typeof runFeedbackUpdateRuntime>[0];
  if (!input?.task || !['codex', 'claude-code'].includes(input.writerId) || typeof input.runsDir !== 'string') {
    throw new Error('Invalid feedback worker input');
  }
  await runFeedbackUpdateRuntime(input, emit);
  emit({ kind: 'result', text: `PR #${input.task.prNumber} feedback completed after independent verification`, prNumber: input.task.prNumber });
} catch (error) {
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
