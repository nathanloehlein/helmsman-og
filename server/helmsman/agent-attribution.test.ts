import { describe, expect, it } from 'vitest';
import { agentAttribution, appendAgentByline, codexSettings, stripAgentByline } from './agent-attribution';
import { codexArgs } from './agents/codex';
import { agentFlags } from './agents/claude-code';
import type { AgentTask } from './agents/adapter';

const task: AgentTask = { ticketId: 'TEST-1', title: 'Fix pagination', repo: 'owner/repo', jiraBaseUrl: '' };
const attribution = agentAttribution('codex', {}, 'review agent');
const footer = '_Helmsman · gpt-6-astra - med_';

describe('agent attribution', () => {
  it.each(['codex', 'pre-pr:codex'])('reports the actual %s defaults and explicit arguments', (adapter) => {
    expect(agentAttribution(adapter, {}, 'review agent')).toEqual({ role: 'review agent', model: 'gpt-6-astra', effort: 'medium' });
    for (const settings of [{ model: 'gpt-5.6-terra', effort: 'high' }, { model: '', effort: '' }, { model: 'bad model', effort: 'unsupported' }, { model: 'gpt-6-astra', effort: 'minimal' }]) {
      const reported = agentAttribution(adapter, settings, 'PR author');
      const args = codexArgs({ ...task, ...settings });
      expect(args[args.indexOf('-m') + 1]).toBe(reported.model);
      expect(args).toContain(`model_reasoning_effort="${reported.effort}"`);
    }
  });

  it.each(['claude-code', 'pre-pr:claude-code'])('reports only explicit validated %s flags', (adapter) => {
    expect(agentAttribution(adapter, {}, 'review agent')).toMatchObject({ model: 'provider default (not reported)', effort: 'provider default (not reported)' });
    const settings = { model: 'sonnet', effort: 'high' };
    const reported = agentAttribution(adapter, settings, 'review agent');
    expect(agentFlags({ ...task, ...settings })).toEqual(['--model', reported.model, '--effort', reported.effort]);
    expect(agentAttribution(adapter, { model: 'bad model', effort: 'minimal' }, 'PR author')).toMatchObject({ model: 'provider default (not reported)', effort: 'provider default (not reported)' });
  });

  it.each(['command', 'custom-adapter', 'pre-pr:command'])('does not claim supplied settings were applied by %s', (adapter) => {
    expect(agentAttribution(adapter, { model: 'gpt-6-astra', effort: 'high' }, 'review agent'))
      .toEqual({ role: 'review agent', model: 'not reported', effort: 'not reported' });
  });

  it('guards nullable and malformed settings without inventing provider defaults', () => {
    expect(codexSettings(null as unknown as AgentTask)).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
    expect(agentAttribution('claude-code', undefined as unknown as AgentTask, 'review agent')).toMatchObject({ model: 'provider default (not reported)', effort: 'provider default (not reported)' });
    expect(codexSettings({ model: 42, effort: {} } as unknown as AgentTask)).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
  });
});

describe('agent bylines', () => {
  it('places the authoritative footer last and separates it from the body', () => {
    expect(appendAgentByline('Review findings.\n', attribution)).toBe(`Review findings.\n\n${footer}`);
    expect(appendAgentByline('', attribution)).toBe(footer);
    expect(appendAgentByline(null as unknown as string, attribution)).toBe(footer);
    expect(appendAgentByline('', agentAttribution('codex', { effort: 'minimal' }, 'PR author'))).toBe('_Helmsman · gpt-6-astra - min_');
    expect(appendAgentByline('PR body', agentAttribution('command', {}, 'PR author')))
      .toBe('PR body\n\n_Helmsman · not reported - not reported_');
  });

  it('is idempotent and replaces recognized trailing attribution without changing the report', () => {
    const body = appendAgentByline('Review findings.', attribution);
    expect(appendAgentByline(body, attribution)).toBe(body);
    expect(stripAgentByline(body)).toBe('Review findings.');
    expect(appendAgentByline(`${body}\n\n${footer}`, attribution)).toBe(body);
    expect(appendAgentByline('Review findings.\n\n_Helmsman review agent · model: gpt-6-astra · effort: medium_', attribution)).toBe(body);
    expect(appendAgentByline(body, agentAttribution('codex', { model: 'gpt-5.6-terra', effort: 'high' }, 'PR author')))
      .toBe('Review findings.\n\n_Helmsman · gpt-5.6-terra - high_');
  });

  it.each([
    `> ${footer}`,
    `Quoted footer: ${footer}`,
    `\`\`\`suggestion\n${footer}\n\`\`\``,
    `~~~typescript\n${footer}\n~~~`,
    `    ${footer}`,
    `_Helmsman unrelated footer · model: gpt-6-astra · effort: medium_`,
    `Paragraph without footer separation\n${footer}`,
  ])('preserves quoted, fenced, indented, and unrelated text %#', (body) => {
    expect(appendAgentByline(body, attribution)).toBe(`${body}\n\n${footer}`);
  });

  it('closes an unfinished fence so the appended footer is outside code and remains idempotent', () => {
    const body = `\`\`\`suggestion\n${footer}  `;
    const result = appendAgentByline(body, attribution);
    expect(result).toBe(`${body}\n\`\`\`\n\n${footer}`);
    expect(appendAgentByline(result, attribution)).toBe(result);
  });

  it('preserves all long-form content so publishers can budget their final payload instead of truncating code', () => {
    const body = 'x'.repeat(65536);
    const result = appendAgentByline(body, attribution);
    expect(result).toBe(`${body}\n\n${footer}`);
    expect(result.length).toBe(body.length + footer.length + 2);
  });
});
