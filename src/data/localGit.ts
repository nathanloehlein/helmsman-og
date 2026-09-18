export interface LocalBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  upstreamStatus?: 'present' | 'gone' | 'none' | 'unknown';
  deletionBlockedReason?: string | null;
  commit: string;
}

export interface LocalWorktree {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  deletionBlockedReason?: string | null;
}

export type LocalGitAction =
  | { action: 'delete-branch'; branch: string; expectedCommit: string; force?: boolean }
  | { action: 'delete-worktree'; path: string; expectedCommit: string }
  | { action: 'refresh-remotes' };

export interface LocalGitResponse {
  repo: string;
  path: string | null;
  branches: LocalBranch[];
  worktrees: LocalWorktree[];
  error: string | null;
}

export interface LocalGitState extends Omit<LocalGitResponse, 'repo'> {
  repo: string | null;
  loading: boolean;
  pendingAction?: string;
  confirmation?: Exclude<LocalGitAction, { action: 'refresh-remotes' }>;
}

export function emptyLocalGit(repo: string | null): LocalGitState {
  return { repo, path: null, branches: [], worktrees: [], error: null, loading: false };
}

function normalizeLocalGit(repo: string, data: Partial<LocalGitResponse> | null): LocalGitState | null {
  if (!data || data.repo !== repo || !Array.isArray(data.branches) || !Array.isArray(data.worktrees)) return null;
  return {
    ...emptyLocalGit(repo),
    path: typeof data.path === 'string' ? data.path : null,
    error: typeof data.error === 'string' ? data.error : null,
    branches: data.branches.filter(branch => branch && typeof branch.name === 'string' && typeof branch.commit === 'string').map(branch => ({
      name: branch.name, current: branch.current === true, upstream: typeof branch.upstream === 'string' ? branch.upstream : null, commit: branch.commit,
      ...(typeof branch.upstreamStatus === 'string' && ['present', 'gone', 'none', 'unknown'].includes(branch.upstreamStatus) ? { upstreamStatus: branch.upstreamStatus } : {}),
      ...(typeof branch.deletionBlockedReason === 'string' ? { deletionBlockedReason: branch.deletionBlockedReason } : {}),
    })),
    worktrees: data.worktrees.filter(tree => tree && typeof tree.path === 'string' && typeof tree.commit === 'string').map(tree => ({
      path: tree.path, branch: typeof tree.branch === 'string' ? tree.branch : null, commit: tree.commit,
      bare: tree.bare === true, detached: tree.detached === true, locked: tree.locked === true, prunable: tree.prunable === true,
      ...(typeof tree.deletionBlockedReason === 'string' ? { deletionBlockedReason: tree.deletionBlockedReason } : {}),
    })),
  };
}

export async function fetchLocalGit(repo: string): Promise<LocalGitState> {
  const empty = emptyLocalGit(repo);
  try {
    const response = await fetch(`/api/repo/local?repo=${encodeURIComponent(repo)}`);
    if (!response.ok) return { ...empty, error: 'Local checkout unavailable for this repository.' };
    return normalizeLocalGit(repo, await response.json() as Partial<LocalGitResponse> | null)
      ?? { ...empty, error: 'Unable to load local branches and worktrees.' };
  } catch {
    return { ...empty, error: 'Unable to load local branches and worktrees.' };
  }
}

export async function updateLocalGit(repo: string, action: LocalGitAction): Promise<LocalGitState> {
  const fallback = { ...emptyLocalGit(repo), error: 'Unable to confirm the result. Refresh local data before retrying.' };
  try {
    const response = await fetch('/api/repo/local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, ...action }),
    });
    const result = normalizeLocalGit(repo, await response.json() as Partial<LocalGitResponse> | null);
    if (!result) return fallback;
    if (!response.ok && !result.error) result.error = 'The operation failed. Refresh local data before retrying.';
    return result;
  } catch {
    return fallback;
  }
}
