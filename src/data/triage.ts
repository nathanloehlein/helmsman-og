import type { Ticket } from '../types';

export interface TriageGroupsView {
  unassignedBacklog: Ticket[];
  unassignedTodo: Ticket[];
  mineOpen: Ticket[];
}

export interface TriageResponseView {
  groups: TriageGroupsView;
  degraded: boolean;
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
}

const EMPTY: TriageGroupsView = { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] };

export async function fetchTriage(repo: string | null): Promise<TriageResponseView> {
  try {
    const url: string = repo ? `/api/triage?repo=${encodeURIComponent(repo)}` : '/api/triage';
    const res: Response = await fetch(url);
    if (!res.ok) return { groups: EMPTY, degraded: true, selectedRepo: repo, jiraBaseUrl: null };
    return (await res.json()) as TriageResponseView;
  } catch {
    return { groups: EMPTY, degraded: true, selectedRepo: repo, jiraBaseUrl: null };
  }
}
