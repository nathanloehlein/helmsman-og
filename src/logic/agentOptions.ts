export interface AgentOption {
  value: string;
  label: string;
}

export const MODEL_OPTIONS: AgentOption[] = [
  { value: '', label: 'Default model' },
  { value: 'gpt-6-astra', label: 'Astra (Codex)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
];

export const EFFORT_OPTIONS: AgentOption[] = [
  { value: '', label: 'Default effort' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const EFFORT_SET: Set<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function validEffort(effort: string | undefined | null): string | null {
  return effort && EFFORT_SET.has(effort) ? effort : null;
}

export function validModel(model: string | undefined | null): string | null {
  return model && /^[a-z0-9][a-z0-9._-]*$/i.test(model) ? model : null;
}
