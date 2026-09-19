export const CLARIFICATION_STATES = ['pending', 'answered', 'timed-out', 'cancelled'] as const;
export const CLARIFICATION_OWNERS = ['local', 'trusted-contact'] as const;
export type ClarificationState = typeof CLARIFICATION_STATES[number];
export type ClarificationOwner = typeof CLARIFICATION_OWNERS[number];
export interface Clarification { id: string; runId: string; repo: string; question: string; required: boolean; owner: ClarificationOwner; contactId: string | null; state: ClarificationState; answer: string | null; createdAt: string; timeoutAt: string | null; answeredAt: string | null; }
export interface TrustedContact { id: string; name: string; address: string; enabled: boolean; createdAt: string; }
