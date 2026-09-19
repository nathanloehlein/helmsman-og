// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { restoreRunAdapter } from './restore';
import { codexAdapter } from './codex';
import { claudeCodeAdapter } from './claude-code';
import type { AgentTask } from './adapter';

const task: AgentTask = { ticketId: 'T-1', title: 'Review', repo: 'org/repo', jiraBaseUrl: '', review: true,
  dockerExecution: { image: 'helmsman:test', runId: 'run-1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'a'.repeat(64) } };

describe('restored run adapters', () => {
  it.each(['codex', 'claude-code'])('restores structured Docker review events for persisted %s runs', adapter => {
    const restored = restoreRunAdapter({ adapter, taskJson: JSON.stringify(task) }, { runsDir: '/runs' });
    const event = { kind: 'usage', text: 'Review usage', provider: adapter, model: 'review-model', stage: 'review', round: 1,
      costUsd: 1.25, usage: { inputTokens: 12, outputTokens: 4 } };
    expect(restored.id).toBe(adapter);
    expect(restored.parseLine(JSON.stringify({ __helmsmanPrePr: 1, ...event }))).toEqual(event);
    expect(restored.buildCommand(task).args[2]).toContain('/docker-review-cli.ts');
  });

  it('preserves local provider and pre-PR adapter selection', () => {
    expect(restoreRunAdapter({ adapter: 'codex', taskJson: JSON.stringify({ ...task, dockerExecution: undefined }) }, { runsDir: '/runs' })).toBe(codexAdapter);
    expect(restoreRunAdapter({ adapter: 'claude-code', taskJson: null }, { runsDir: '/runs' })).toBe(claudeCodeAdapter);
    expect(restoreRunAdapter({ adapter: 'pre-pr:codex', taskJson: JSON.stringify(task) }, { runsDir: '/runs' }).id).toBe('pre-pr:codex');
    expect(restoreRunAdapter({ adapter: 'command', taskJson: null }, { runsDir: '/runs', agentCmd: 'echo run' }).id).toBe('command');
  });

  it('leaves malformed task failure handling to the runner', () => {
    expect(restoreRunAdapter({ adapter: 'codex', taskJson: '{' }, { runsDir: '/runs' })).toBe(codexAdapter);
  });
});
