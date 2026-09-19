import { fileURLToPath } from 'node:url';
import { normalizePrePrSettings, type PrePrSettings } from '../../../src/logic/prePrSettings';
import type { AgentAdapter, AgentEvent, AgentEventKind } from './adapter';

const KINDS = new Set<AgentEventKind>(['phase', 'tool', 'log', 'result', 'usage', 'error', 'review-verdict', 'run-complete']);
const PREFIX = 'pre-pr:';

export function isPrePrAdapter(id: string): boolean {
  return id === `${PREFIX}codex` || id === `${PREFIX}claude-code`;
}

export function prePrAdapter(writer: AgentAdapter, runsDir: string, settings?: PrePrSettings): AgentAdapter {
  if (!['codex', 'claude-code'].includes(writer.id)) throw new Error('Pre-PR review requires the Codex or Claude Code adapter');
  const reviewSettings = normalizePrePrSettings(settings);
  return {
    id: `${PREFIX}${writer.id}`,
    buildCommand(task) {
      if (task.review || task.prBranch) throw new Error('The pre-PR workflow is only for new coding voyages');
      return {
        cmd: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../pre-pr-cli.ts', import.meta.url)),
          JSON.stringify({ task, writerId: writer.id, runsDir, settings: reviewSettings })],
      };
    },
    parseLine(line) {
      if (!line) return null;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && '__helmsmanPrePr' in value && value.__helmsmanPrePr === 1
          && 'kind' in value && KINDS.has(value.kind as AgentEventKind) && 'text' in value && typeof value.text === 'string') {
          const event: AgentEvent = { kind: value.kind as AgentEventKind, text: value.text };
          if ('eventId' in value && typeof value.eventId === 'string' && value.eventId.length <= 256) event.eventId = value.eventId;
          if ('usage' in value && value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
            const usage = value.usage as Record<string, unknown>;
            const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const;
            if (fields.some(field => usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0))) return { kind: 'log', text: line };
            event.usage = Object.fromEntries(fields.filter(field => usage[field] !== undefined).map(field => [field, usage[field]]));
          }
          const record = value as Record<string, unknown>;
          for (const field of ['provider', 'model', 'effort', 'stage'] as const) if (typeof record[field] === 'string' && record[field].length <= 128) event[field] = record[field];
          if ('round' in value && Number.isSafeInteger(value.round) && Number(value.round) >= 0) event.round = Number(value.round);
          if ('costUsd' in value && typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) event.costUsd = value.costUsd;
          if (event.kind === 'result' && 'prNumber' in value && typeof value.prNumber === 'number'
            && Number.isSafeInteger(value.prNumber) && value.prNumber > 0) event.prNumber = value.prNumber;
          return event;
        }
      } catch {}
      return { kind: 'log', text: line };
    },
  };
}
