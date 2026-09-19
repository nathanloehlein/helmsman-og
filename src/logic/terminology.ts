export const TERMINOLOGY = {
  success: { plain: 'Succeeded', pirate: 'Shipshape' },
  failed: { plain: 'Failed', pirate: 'Marooned' },
  stopped: { plain: 'Stopped', pirate: 'Stopped' },
  tokens: { plain: 'Tokens', pirate: 'Pieces of eight' },
  agent: { plain: 'Agent', pirate: 'Deckhand' },
  agents: { plain: 'Agents', pirate: 'Deckhands' },
  start: { plain: 'Start', pirate: 'Weigh anchor' },
  review: { plain: 'Review', pirate: 'Inspection' },
  inReview: { plain: 'In review', pirate: 'In inspection' },
  reviewRequested: { plain: 'Review requested', pirate: 'Inspection requested' },
  launchingRun: { plain: 'Starting run…', pirate: 'Weighing anchor…' },
  retryFailed: { plain: 'Run retry failed.', pirate: 'Voyage retry marooned.' },
  launchFailed: { plain: 'Run launch failed.', pirate: 'Voyage launch marooned.' },
  relaunchFailed: { plain: 'Run relaunch failed.', pirate: 'Voyage relaunch marooned.' },
  reviewFailed: { plain: 'Review failed.', pirate: 'Inspection marooned.' },
  unavailableRunTitle: { plain: 'Run unavailable', pirate: 'Voyage unavailable' },
  unavailableRunMessage: { plain: 'This run was not found or the server is unavailable.', pirate: 'This voyage was not found or the server is unavailable.' },
  unavailableDashboard: { plain: 'Dashboard unavailable for this repository. Try refreshing.', pirate: 'Helm unavailable for this galleon. Try refreshing.' },
  prLookupInvalid: { plain: 'Enter a PR URL or owner/name#number.', pirate: 'Enter a bounty URL or owner/name#number.' },
  ticketStatus: { plain: 'Ticket status', pirate: 'Ticket bearings' },
  reviews: { plain: 'Reviews', pirate: 'Inspections' },
  pr: { plain: 'PR', pirate: 'Bounty' },
  prs: { plain: 'PRs', pirate: 'Bounties' },
  repository: { plain: 'Repository', pirate: 'Galleon' },
  repositories: { plain: 'Repositories', pirate: 'Galleons' },
  run: { plain: 'Run', pirate: 'Voyage' },
  runs: { plain: 'Runs', pirate: 'Voyages' },
  dashboard: { plain: 'Dashboard', pirate: 'Helm' },
  systemStatus: { plain: 'System status', pirate: 'Fleet status' },
  mineRunning: { plain: 'Mine · running', pirate: 'Mine · underway' },
  unavailableRunningTickets: { plain: 'Assigned tickets unavailable.', pirate: 'Underway tickets unavailable.' },
  invalidRunId: { plain: 'Invalid run ID.', pirate: 'Invalid voyage ID.' },
  missingRetryRunId: { plain: 'The server did not return a new run ID. Check recent runs before retrying.', pirate: 'The server did not return a new voyage ID. Check recent voyages before retrying.' },
  unavailableCheckout: { plain: 'Local checkout unavailable for this repository.', pirate: 'Local checkout unavailable for this galleon.' },
  bootStatus: { plain: 'Helmsman is starting', pirate: 'Helmsman preparing to get underway' },
  bootTagline: { plain: 'LOADING DASHBOARD · PREPARING WORKSPACE', pirate: 'TAKING THE HELM · CHARTING THE COURSE' },
  bootNavigation: { plain: 'navigation · ready', pirate: 'navigation · ready' },
  bootHeading: { plain: 'settings · loaded', pirate: 'heading · set' },
  bootCourse: { plain: 'workspace · ready', pirate: 'course · plotted' },
  bootCrew: { plain: 'agents · standing by', pirate: 'crew · standing by' },
  bootReady: { plain: 'ready to start', pirate: 'ready to get underway' },
  crew: { plain: 'Agents', pirate: 'Crew' },
  greeting: { plain: 'Hello', pirate: 'Ahoy' },
  allRepositories: { plain: 'All repositories', pirate: 'All galleons' },
  scopeByRepository: { plain: 'Scope by repository', pirate: 'Scope by galleon' },
  newRun: { plain: 'New run', pirate: 'New voyage' },
  recentRuns: { plain: 'Recent runs', pirate: 'Recent voyages' },
  activeAgents: { plain: 'Active agents', pirate: 'Active deckhands' },
  openPrs: { plain: 'Open PRs', pirate: 'Open bounties' },
  reviewRequests: { plain: 'Review requests', pirate: 'Inspection requests' },
  myOpenPrs: { plain: 'My open PRs', pirate: 'My open bounties' },
  recentPrRuns: { plain: 'Recent PR runs', pirate: 'Recent bounty voyages' },
  allRuns: { plain: 'All runs', pirate: 'All voyages' },
  launchTicket: { plain: 'Launch ticket', pirate: 'All Hands on Deck' },
  launchRun: { plain: 'Start run', pirate: 'Weigh anchor' },
  runPr: { plain: 'Run a PR', pirate: 'Sail for a bounty' },
  reviewPr: { plain: 'Review a PR', pirate: 'Inspect a bounty' },
  runSource: { plain: 'Run source', pirate: 'Voyage source' },
  selectRepository: { plain: 'Select a repository', pirate: 'Select a galleon' },
  noRuns: { plain: 'No past runs.', pirate: 'No past voyages.' },
  noRecentPrRuns: { plain: 'No recent PR runs for this repository scope.', pirate: 'No recent bounty voyages for this galleon scope.' },
  codeReview: { plain: 'Code review with agents', pirate: 'Code inspection with deckhands' },
  lastReviewed: { plain: 'Last reviewed by you', pirate: 'Last inspected by you' },
  notReviewed: { plain: 'Not reviewed yet', pirate: 'Not inspected yet' },
  freeformRun: { plain: 'Freeform run', pirate: 'Freeform voyage' },
  shipped: { plain: 'Completed work', pirate: 'Out to sea' },
  activity: { plain: 'Activity log', pirate: "Ship's log" },
  running: { plain: 'Running', pirate: 'Underway' },
  agentTasks: { plain: 'Agent tasks', pirate: 'Deckhand tasks' },
  retryRun: { plain: 'Retry failed run', pirate: 'Retry marooned voyage' },
  retryRunHint: { plain: 'Start a fresh run with the original task and settings', pirate: 'Start a fresh voyage with the original task and settings' },
  launchScopeHint: { plain: 'Select a repository to start a run.', pirate: 'Select a galleon to weigh anchor.' },
  noAgentTasks: { plain: 'No agent tasks running.', pirate: 'No deckhand tasks underway.' },
  noOpenTasks: { plain: 'No agent tasks open. Select active agents or a recent run to view its tasks here.', pirate: 'No deckhand tasks open. Select active deckhands or a recent voyage to view its tasks here.' },
  noReviewResult: { plain: 'Completed · No review recommendation recorded', pirate: 'Shipshape · No inspection recommendation recorded' },
  selectRepoPrs: { plain: 'Select a repository to see its open PRs.', pirate: 'Select a galleon to see its open bounties.' },
  noRepoPrs: { plain: 'No open pull requests in this repository.', pirate: 'No open bounties in this galleon.' },
  noRecentPrs: { plain: 'No recent pull requests.', pirate: 'No recent bounties.' },
  noPrFound: { plain: 'No PR found.', pirate: 'No bounty found.' },
  noReviewRequests: { plain: 'No PRs awaiting your review.', pirate: 'No bounties awaiting your inspection.' },
  noAuthoredPrs: { plain: 'You have no open pull requests.', pirate: 'You have no open bounties.' },
  loadingPrs: { plain: 'Loading PRs…', pirate: 'Loading bounties…' },
  loadingPr: { plain: 'Loading PR…', pirate: 'Loading bounty…' },
  unavailablePrs: { plain: 'GitHub PRs are unavailable. Retrying shortly.', pirate: 'GitHub bounties are unavailable. Retrying shortly.' },
  noMatchingPrs: { plain: 'No matching PRs in the retrieved results.', pirate: 'No matching bounties in the retrieved results.' },
  morePrs: { plain: 'Showing the most recent results. More PRs may be available on GitHub.', pirate: 'Showing the most recent results. More bounties may be available on GitHub.' },
  prLookupHint: { plain: 'Enter a PR above to review it.', pirate: 'Enter a bounty above to inspect it.' },
  prPlaceholder: { plain: 'Paste a PR URL or owner/name#number', pirate: 'Paste a bounty URL or owner/name#number' },
  requestSlackReview: { plain: 'Request review in Slack', pirate: 'Request inspection in Slack' },
  crewUnavailable: { plain: 'Agent actions unavailable: this repository is not checked out locally.', pirate: 'Deckhand actions unavailable: this galleon is not checked out locally.' },
  operatorNote: { plain: 'Read/write scoped to this branch only. Merge requires human approval — the agent never merges to main, and there is no merge control here.', pirate: 'Read/write scoped to this branch only. Merge requires human approval — the deckhand never merges to main, and there is no merge control here.' },
} as const;

export type TermKey = keyof typeof TERMINOLOGY;

export const TERMINOLOGY_REFERENCE_KEYS = [
  'dashboard', 'run', 'runs', 'repository', 'repositories', 'crew', 'agent', 'agents',
  'agentTasks', 'activeAgents', 'running', 'systemStatus', 'shipped', 'activity',
  'success', 'failed', 'tokens', 'start', 'review', 'reviews', 'pr', 'prs',
  'launchTicket', 'greeting',
] as const satisfies readonly TermKey[];

export function wording(key: TermKey, enabled: boolean): string {
  return TERMINOLOGY[key][enabled ? 'pirate' : 'plain'];
}

let fallbackMode = true;
let volatileMode: boolean | null = null;

export function isPirateMode(): boolean {
  if (volatileMode !== null) return volatileMode;
  try {
    return localStorage.getItem('helmsman.pirateMode') !== 'false';
  } catch {
    return fallbackMode;
  }
}

export function setPirateMode(enabled: boolean): void {
  fallbackMode = enabled;
  try {
    localStorage.setItem('helmsman.pirateMode', String(enabled));
    volatileMode = null;
  } catch {
    volatileMode = enabled;
  }
}

export function term(key: TermKey): string {
  return wording(key, isPirateMode());
}
