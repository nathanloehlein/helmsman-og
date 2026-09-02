export interface AgentTask {
  ticketId: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
  task?: string;
  prBranch?: string;
  prNumber?: number;
  review?: boolean;
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

export interface AgentHandle {
  stop(): void;
  readonly exit: Promise<AgentResult>;
}

export interface AgentAdapter {
  readonly id: string;
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle;
}
