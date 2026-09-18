import type { LocalGitState } from './data/localGit';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import './localGit.css';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function shortCommit(value: unknown): string {
  const commit = text(value);
  return commit ? `<span class="local-git-commit mono" title="${esc(commit)}">${esc(commit.slice(0, 8))}</span>` : '';
}

export function renderLocalGit(state: LocalGitState): string {
  const repo = text(state?.repo);
  const path = text(state?.path);
  const error = text(state?.error);
  const loading = Boolean(state?.loading);
  const busy = loading || Boolean(state?.pendingAction);
  const branches = (Array.isArray(state?.branches) ? state.branches : [])
    .filter((branch) => branch && text(branch.name));
  const worktrees = (Array.isArray(state?.worktrees) ? state.worktrees : [])
    .filter((worktree) => worktree && text(worktree.path));
  const branchRows = branches.map((branch) => {
    const blocked = text(branch.deletionBlockedReason) || (branch.current ? 'The current branch cannot be deleted.' : '');
    const upstream = text(branch.upstream);
    const tracking = branch.upstreamStatus === 'gone'
      ? `<span class="local-git-gone">Remote branch gone</span>${upstream ? ` · <span class="mono">${esc(upstream)}</span>` : ''}`
      : !upstream || branch.upstreamStatus === 'none' ? 'No upstream configured'
      : `Tracks <span class="mono">${esc(upstream)}</span>${branch.upstreamStatus === 'unknown' ? ' · Remote status unavailable' : ''}`;
    return `<li class="local-git-item">
      <div class="local-git-item-head"><span class="local-git-name mono">${esc(branch.name)}</span>${branch.current ? '<span class="chip chip-progress">Current</span>' : ''}${shortCommit(branch.commit)}</div>
      <div class="local-git-upstream">${tracking}</div>
      <div class="local-git-item-actions"><button class="local-git-delete" type="button" data-local-branch="${esc(branch.name)}"${busy || blocked ? ' disabled' : ''}${blocked ? ` title="${esc(blocked)}"` : ''}>Delete branch</button>${blocked ? `<span class="local-git-blocked">${esc(blocked)}</span>` : ''}</div>
    </li>`;
  }).join('');
  const worktreeRows = worktrees.map((worktree) => {
    const blocked = text(worktree.deletionBlockedReason) || (worktree.locked ? 'Unlock this worktree before deleting it.' : worktree.bare ? 'Bare worktrees cannot be deleted here.' : worktree.path === path ? 'The selected checkout cannot be deleted.' : '');
    return `<li class="local-git-item">
      <div class="local-git-item-head"><span class="local-git-name mono">${esc(worktree.bare ? 'Bare' : worktree.detached ? 'Detached HEAD' : text(worktree.branch) || 'No branch')}</span>${worktree.locked ? '<span class="chip chip-progress">Locked</span>' : ''}${worktree.prunable ? '<span class="chip chip-blocked">Prunable</span>' : ''}${shortCommit(worktree.commit)}</div>
      <div class="local-git-path mono">${esc(worktree.path)}</div>
      <div class="local-git-item-actions"><button class="local-git-delete" type="button" data-local-worktree="${esc(worktree.path)}"${busy || blocked ? ' disabled' : ''}${blocked ? ` title="${esc(blocked)}"` : ''}>Delete worktree</button>${blocked ? `<span class="local-git-blocked">${esc(blocked)}</span>` : ''}</div>
    </li>`;
  }).join('');
  const confirmation = state?.confirmation;
  const cleanup = state?.cleanup;
  const cleanupForce = cleanup?.force ?? state?.cleanupForce ?? false;
  const candidates = Array.isArray(cleanup?.candidates) ? cleanup.candidates.filter(item => item && text(item.branch) && text(item.expectedCommit)) : [];
  const skipped = Array.isArray(cleanup?.skipped) ? cleanup.skipped.filter(item => item && text(item.branch)) : [];
  const cleanupPanel = cleanup ? `<div class="local-git-confirmation local-git-cleanup" role="region" aria-label="Preview branch cleanup">
    <strong>${candidates.length ? `Delete ${candidates.length} local branch${candidates.length === 1 ? '' : 'es'} without upstreams?` : 'No local branches are ready for cleanup.'}</strong>
    ${cleanup.force ? '<p class="local-git-cleanup-warning" role="alert">This preview includes unmerged branches. Deleting them may permanently lose local commits that have not been merged.</p>' : '<p>Only branches merged into the selected checkout are included.</p>'}
    <p>Current, default, and checked-out branches are protected. Remote branches are unchanged.</p>
    ${candidates.length ? `<ul class="local-git-cleanup-list" aria-label="Branches to delete">${candidates.map(item => `<li><span class="local-git-name mono">${esc(item.branch)}</span>${shortCommit(item.expectedCommit)}<span class="local-git-cleanup-reason">${item.upstreamStatus === 'gone' ? 'Upstream branch gone' : 'No upstream configured'}</span></li>`).join('')}</ul>` : ''}
    ${skipped.length ? `<details class="local-git-cleanup-skipped"${candidates.length ? '' : ' open'}><summary>${skipped.length} branch${skipped.length === 1 ? '' : 'es'} skipped</summary><ul class="local-git-cleanup-list" aria-label="Branches kept">${skipped.map(item => `<li><span class="local-git-name mono">${esc(item.branch)}</span><span class="local-git-cleanup-reason">${esc(text(item.reason))}</span></li>`).join('')}</ul></details>` : ''}
    <div class="local-git-item-actions"><button class="local-git-cleanup-confirm local-git-delete" type="button"${busy || !candidates.length ? ' disabled' : ''}>Delete ${candidates.length} branch${candidates.length === 1 ? '' : 'es'}</button><button class="local-git-cleanup-cancel local-git-refresh" type="button"${busy ? ' disabled' : ''}>Cancel</button></div>
  </div>` : '';
  const confirmationPanel = confirmation ? `<div class="local-git-confirmation" role="region" aria-label="Confirm deletion">
    <strong>Delete ${confirmation.action === 'delete-branch' ? 'local branch' : 'worktree'} <span class="mono">${esc(confirmation.action === 'delete-branch' ? confirmation.branch : confirmation.path)}</span>?</strong>
    <p>${confirmation.action === 'delete-branch' ? 'This removes the local branch. The remote branch is unchanged.' : 'This removes the worktree directory. Its branch is kept. Worktrees with uncommitted changes cannot be deleted.'}</p>
    ${confirmation.action === 'delete-branch' ? '<label class="local-git-force-label"><input class="local-git-force" type="checkbox"> Also delete if unmerged (may lose local commits)</label>' : ''}
    <div class="local-git-item-actions"><button class="local-git-confirm-delete local-git-delete" type="button"${busy ? ' disabled' : ''}>Confirm deletion</button><button class="local-git-cancel local-git-refresh" type="button"${busy ? ' disabled' : ''}>Cancel</button></div>
  </div>` : '';
  const content = !repo
    ? '<div class="empty-note">Select a repo to see its local branches and worktrees.</div>'
    : `${path ? `<div class="local-git-checkout"><span class="local-git-label">Selected checkout</span><span class="local-git-path mono">${esc(path)}</span></div>` : ''}
      ${error ? `<div class="local-git-error" role="alert">${esc(error)}</div>` : ''}
      ${busy ? `<div class="empty-note" role="status">${esc(state?.pendingAction || 'Loading local branches and worktrees…')}</div>` : ''}
      ${confirmationPanel}
      ${cleanupPanel}
      ${!loading && !error || branches.length || worktrees.length ? `<div class="local-git-columns">
        <section class="local-git-group" aria-label="Local branches"><h3>Branches <span class="local-git-count mono">${branches.length}</span></h3><ul class="local-git-list">${branchRows || '<li class="empty-note">No local branches.</li>'}</ul></section>
        <section class="local-git-group" aria-label="Local worktrees"><h3>Worktrees <span class="local-git-count mono">${worktrees.length}</span></h3><ul class="local-git-list">${worktreeRows || '<li class="empty-note">No local worktrees.</li>'}</ul></section>
      </div>` : ''}`;
  return `<section class="panel local-git-panel" data-pane="local-git" aria-busy="${busy}">
    <div class="panel-head"><span class="panel-title">Local branches &amp; worktrees</span><div class="local-git-actions"><button class="local-git-refresh" type="button"${busy || !repo ? ' disabled' : ''}>Refresh</button><button class="local-git-check-remotes local-git-refresh" type="button"${busy || !repo ? ' disabled' : ''}>Check remotes</button><a class="app-link pane-link" href="${esc(routeHref({ view: 'config', repo: repo || null, pane: 'local-git' }))}" aria-label="Link to local branches and worktrees">↗</a></div></div>
    ${repo ? '<p class="local-git-hint">Remote status uses local tracking refs. Check remotes fetches and prunes them to detect deleted remote branches. Refresh only reads local data.</p>' : ''}
    <div class="local-git-cleanup-controls"><label class="local-git-force-label"><input class="local-git-cleanup-force" type="checkbox"${cleanupForce ? ' checked' : ''}${busy || !repo || !path ? ' disabled' : ''}> Include unmerged branches</label><button class="local-git-cleanup-preview local-git-delete" type="button"${busy || !repo || !path ? ' disabled' : ''}>Clean up branches without upstreams</button></div>
    ${content}
  </section>`;
}
