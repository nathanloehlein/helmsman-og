/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { chunkArgument, joinArgumentChunks } from './argv-chunks';
import type { AgentTask } from './agents/adapter';
import { codexAdapter } from './agents/codex';
import { feedbackUpdateAdapter } from './agents/feedback-update';
import { prePrAdapter } from './agents/pre-pr';
import { dockerReviewAdapter } from './agents/docker-review';
import { routeAgentCommand } from './gocaas';
import { interactiveAgentCommand } from './interactive-agent';

const big = 'x'.repeat(5000) + '🚢'.repeat(500) + '\n"quoted"\\path\n'.repeat(200);

describe('chunkArgument / joinArgumentChunks', () => {
  it('splits into argv-safe chunks and round-trips without altering unicode or newlines', () => {
    const chunks = chunkArgument(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 256)).toBe(true);
    expect(joinArgumentChunks(chunks)).toBe(big);
  });

  it('never splits a surrogate pair across chunk boundaries', () => {
    const value = 'a'.repeat(255) + '😀'.repeat(10);
    const chunks = chunkArgument(value);
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(joinArgumentChunks(chunks)).toBe(value);
  });

  it('produces an empty-safe chunk list for short or empty input', () => {
    expect(chunkArgument('')).toEqual([]);
    expect(joinArgumentChunks(chunkArgument(''))).toBe('');
    expect(chunkArgument('short')).toEqual(['short']);
  });

  it('joining a single legacy argument is a no-op', () => {
    expect(joinArgumentChunks([JSON.stringify({ a: 1 })])).toBe(JSON.stringify({ a: 1 }));
  });
});

const baseTask: AgentTask = { ticketId: 'T-1', title: `Large task ${big}`, repo: 'org/repo', jiraBaseUrl: '', jiraContext: big };

describe('launcher argv chunking for large tasks', () => {
  const cases: { name: string; args(): string[]; sliceFrom: number; original(): unknown }[] = [
    {
      name: 'feedback-update',
      sliceFrom: 3,
      args: () => feedbackUpdateAdapter(codexAdapter, '/runs').buildCommand(
        { ...baseTask, prNumber: 1, prBranch: 'fix/x', feedbackWorkflow: true }).args,
      original: () => ({ task: { ...baseTask, prNumber: 1, prBranch: 'fix/x', feedbackWorkflow: true }, writerId: 'codex', runsDir: '/runs',
        settings: { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 } }),
    },
    {
      name: 'pre-pr',
      sliceFrom: 3,
      args: () => prePrAdapter(codexAdapter, '/runs').buildCommand(baseTask).args,
      original: () => ({ task: baseTask, writerId: 'codex', runsDir: '/runs', settings: { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 } }),
    },
    {
      name: 'docker-review',
      sliceFrom: 3,
      args: () => dockerReviewAdapter(codexAdapter).buildCommand(
        { ...baseTask, review: true, dockerExecution: { runId: 'r1', image: 'test:1', gatewayUrl: 'http://x', capability: 'a'.repeat(64) } }).args,
      original: () => ({ task: { ...baseTask, review: true, dockerExecution: { runId: 'r1', image: 'test:1', gatewayUrl: 'http://x', capability: 'a'.repeat(64) } }, reviewerId: 'codex' }),
    },
    {
      name: 'gocaas',
      sliceFrom: 4,
      args: () => routeAgentCommand({ ...baseTask, modelRouting: 'gocaas' }, 'codex', { cmd: 'codex', args: ['exec', big] }).args,
      original: () => ['exec', big],
    },
    {
      name: 'interactive-agent',
      sliceFrom: 3,
      args: () => interactiveAgentCommand({ ...baseTask, instructionsDir: '/tmp/instructions' }, 'codex').args,
      original: () => ({ provider: 'codex', task: { ...baseTask, instructionsDir: '/tmp/instructions' } }),
    },
  ];

  it.each(cases)('$name keeps every argv element at or under 256 chars and the CLI-side join round-trips it', ({ args, sliceFrom, original }) => {
    const argv = args();
    const chunks = argv.slice(sliceFrom);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 256)).toBe(true);
    expect(JSON.parse(joinArgumentChunks(chunks))).toEqual(original());
  });
});
