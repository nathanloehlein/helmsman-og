export interface AgentTask {
  ticketId: string;
  todoId?: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
  task?: string;
  prBranch?: string;
  prNumber?: number;
  review?: boolean;
  model?: string;
  effort?: string;
  prHeadSha?: string;
  reviewComplexity?: 'low' | 'medium' | 'high';
  reviewReason?: string;
  prePr?: {
    stage: 'implement' | 'review' | 'fix';
    baseSha: string;
    headSha?: string;
    reportPath: string;
    feedback?: string;
    round?: number;
  };
}

export type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'error' | 'review-verdict' | 'run-complete';

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
