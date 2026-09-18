export type CmuxAction = 'enter' | 'escape' | 'interrupt' | 'continue' | 'stop' | 'approve';
export interface ActionSpec {
  action: CmuxAction;
  label: string;
  keys: string[];
}

const UNIVERSAL: ActionSpec[] = [
  { action: 'enter', label: 'Enter', keys: ['Enter'] },
  { action: 'escape', label: 'Esc', keys: ['Escape'] },
  { action: 'interrupt', label: 'Ctrl-C', keys: ['C-c'] },
];

const AGENT: ActionSpec[] = [
  { action: 'continue', label: 'Continue', keys: ['Enter'] },
  { action: 'stop', label: 'Stop', keys: ['Escape'] },
  { action: 'approve', label: 'Approve', keys: ['y', 'Enter'] },
];

const AGENT_PROVIDERS = new Set(['claude', 'codex', 'opencode']);

export function actionsFor(provider: string | null): ActionSpec[] {
  return provider && AGENT_PROVIDERS.has(provider) ? [...UNIVERSAL, ...AGENT] : [...UNIVERSAL];
}

export function keysFor(provider: string | null, action: CmuxAction): string[] | null {
  const spec = actionsFor(provider).find((a) => a.action === action);
  return spec ? spec.keys : null;
}
