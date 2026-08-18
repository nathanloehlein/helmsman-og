export interface JiraChangeItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

export interface JiraHistory {
  created: string;
  items: JiraChangeItem[];
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    priority: { name: string } | null;
    resolutiondate: string | null;
  };
  changelog?: { histories: JiraHistory[] };
}

export type PrReviewDecision = 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | null;

export interface GithubPr {
  number: number;
  title: string;
  headRef: string;
  authorLogin: string;
  mergedAt: string | null;
  createdAt: string;
  reviewDecision: PrReviewDecision;
  repo?: string;
}
