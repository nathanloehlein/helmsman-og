import { fileURLToPath } from 'node:url';
import { normalizePrePrSettings, type PrePrSettings } from '../../../src/logic/prePrSettings';
import type { AgentAdapter } from './adapter';
import { prePrAdapter } from './pre-pr';

export function isFeedbackUpdateAdapter(id: string): boolean {
  return id === 'feedback:codex' || id === 'feedback:claude-code';
}

export function feedbackUpdateAdapter(writer: AgentAdapter, runsDir: string, settings?: PrePrSettings): AgentAdapter {
  const protocol = prePrAdapter(writer, runsDir, settings);
  return {
    id: `feedback:${writer.id}`,
    parseLine: protocol.parseLine,
    buildCommand(task) {
      if (task.review || !task.prBranch || !task.prNumber || !task.feedbackWorkflow) {
        throw new Error('Feedback workflow requires an existing PR update');
      }
      return { cmd: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../feedback-update-cli.ts', import.meta.url)),
          JSON.stringify({ task, writerId: writer.id, runsDir, settings: normalizePrePrSettings(settings) })] };
    },
  };
}
