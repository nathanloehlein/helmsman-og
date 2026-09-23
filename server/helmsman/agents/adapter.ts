export interface AgentTask {
  contactHints?: { explicitContactId?: string; assigneeId?: string; reporterId?: string };
  ticketId: string;
  todoId?: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
  jiraContext?: string;
  task?: string;
  prBranch?: string;
  prNumber?: number;
  review?: boolean;
  model?: string;
  effort?: string;
  prHeadSha?: string;
  reviewComplexity?: 'low' | 'medium' | 'high';
  reviewReason?: string;
  reviewOutputPaths?: { markdown: string; comments: string };
  clarification?: { questionsPath: string; answersPath: string; gateUrl?: string; gateToken?: string };
  workflowSnapshotId?: string;
  skillsPath?: string;
  promptRevision?: string;
  modelRouting?: 'gocaas';
  dockerExecution?: { image: string; gatewayUrl: string; capability: string; runId: string; runtimeRoot?: string };
  prePrResume?: {
    baseSha: string;
    headSha: string;
    branch: string;
    round: number;
    reviewerReports: Record<string, string>;
    metadataPath: string;
  };
  prePr?: {
    stage: 'implement' | 'review' | 'fix';
    baseSha: string;
    headSha?: string;
    reportPath: string;
    feedback?: string;
    round?: number;
    incompleteReview?: { reportPath: string; summary: string };
    summaryCorrection?: { reportPath: string; actualLength: number };
  };
}

export type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'usage' | 'error' | 'review-verdict' | 'run-complete';

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
  costUsd?: number;
  prNumber?: number;
  eventId?: string;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
  effort?: string;
  stage?: string;
  round?: number;
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
