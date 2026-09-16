export interface AgentTask {
  ticketId: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
  task?: string;
  prBranch?: string;
  prNumber?: number;
  review?: boolean;
  model?: string;
  effort?: string;
}

export type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'error' | 'run-complete';

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
  costUsd?: number;
  prNumber?: number;
}

export interface AgentResult {
  ok: boolean;
  prNumber?: number;
  costUsd?: number;
}

export interface AgentAdapter {
  readonly id: string;
  buildCommand(task: AgentTask): { cmd: string; args: string[] };
  parseLine(line: string): AgentEvent | null;
}
