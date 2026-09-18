import type { AgentTask } from './agents/adapter';
import { validEffort, validModel } from '../../src/logic/agentOptions';

export interface AgentAttribution {
  role: 'review agent' | 'PR author';
  model: string;
  effort: string;
}

type AgentSettings = Pick<AgentTask, 'model' | 'effort'>;

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDER_DEFAULT = 'provider default (not reported)';
const NOT_REPORTED = 'not reported';
const MODEL_FIELD = '(?:[a-z0-9][a-z0-9._-]*|provider default \\(not reported\\)|not reported)';
const EFFORT_FIELD = '(?:minimal|low|medium|high|xhigh|max|provider default \\(not reported\\)|not reported)';
const BYLINE = new RegExp(`^_Helmsman (?:review agent|PR author) · model: ${MODEL_FIELD} · effort: ${EFFORT_FIELD}_$`, 'i');

export function validCodexEffort(effort: string | undefined | null): string | null {
  return typeof effort === 'string' && CODEX_EFFORTS.has(effort) ? effort : null;
}

export function codexSettings(task: AgentSettings): { model: string; effort: string } {
  return {
    model: validModel(typeof task?.model === 'string' ? task.model : null) ?? 'gpt-6-astra',
    effort: validCodexEffort(task?.effort) ?? 'medium',
  };
}

export function agentAttribution(adapterId: string, task: AgentSettings, role: AgentAttribution['role']): AgentAttribution {
  if (adapterId === 'codex' || adapterId === 'pre-pr:codex') return { role, ...codexSettings(task) };
  if (adapterId === 'claude-code' || adapterId === 'pre-pr:claude-code') {
    return {
      role,
      model: validModel(typeof task?.model === 'string' ? task.model : null) ?? PROVIDER_DEFAULT,
      effort: validEffort(typeof task?.effort === 'string' ? task.effort : null) ?? PROVIDER_DEFAULT,
    };
  }
  return { role, model: NOT_REPORTED, effort: NOT_REPORTED };
}

function unclosedFence(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)\r?$/);
    const marker = match?.[1];
    if (!marker) continue;
    if (fence === null) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && !match?.[2]?.trim()) fence = null;
  }
  return fence;
}

function attributionField(value: string | undefined | null, kind: 'model' | 'effort'): string {
  if (value === PROVIDER_DEFAULT || value === NOT_REPORTED) return value;
  return kind === 'model'
    ? validModel(typeof value === 'string' ? value : null) ?? NOT_REPORTED
    : validCodexEffort(value) ?? NOT_REPORTED;
}

export function stripAgentByline(body: string): string {
  const original = typeof body === 'string' ? body : '';
  let content = unclosedFence(original) ? original.replace(/(?:\r?\n)+$/, '') : original.trimEnd();
  while (content) {
    const boundary = content.lastIndexOf('\n');
    const lastLine = content.slice(boundary + 1);
    const preceding = boundary < 0 ? '' : content.slice(0, boundary);
    if (!BYLINE.test(lastLine) || preceding && (!/\n\s*$/.test(preceding) || unclosedFence(preceding))) break;
    content = preceding.trimEnd();
  }
  return content;
}

export function appendAgentByline(body: string, attribution: AgentAttribution): string {
  let content = stripAgentByline(body);
  const fence = unclosedFence(content);
  if (fence) content += `\n${fence}`;
  const role = attribution?.role === 'PR author' ? 'PR author' : 'review agent';
  const footer = `_Helmsman ${role} · model: ${attributionField(attribution?.model, 'model')} · effort: ${attributionField(attribution?.effort, 'effort')}_`;
  return content ? `${content}\n\n${footer}` : footer;
}
