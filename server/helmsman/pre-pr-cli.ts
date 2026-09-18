import type { AgentEvent } from './agents/adapter';
import { runPrePrRuntime } from './pre-pr-runtime';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify({ __helmsmanPrePr: 1, ...event })}\n`);
try {
  const serialized = process.argv[2];
  if (!serialized) throw new Error('Pre-PR worker input is required');
  const input = JSON.parse(serialized) as Parameters<typeof runPrePrRuntime>[0];
  if (!input?.task || !['codex', 'claude-code'].includes(input.writerId) || typeof input.runsDir !== 'string') throw new Error('Invalid pre-PR worker input');
  const prNumber = await runPrePrRuntime(input, emit);
  emit({ kind: 'result', text: `Created PR #${prNumber} after adversarial approval`, prNumber });
} catch (error) {
  emit({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
