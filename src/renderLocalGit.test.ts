import { describe, expect, it } from 'vitest';
import type { LocalGitState } from './data/localGit';
import { renderLocalGit } from './renderLocalGit';

function render(overrides: Partial<LocalGitState> = {}): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = renderLocalGit({
    repo: 'owner/repo', path: '/workspace/repo', branches: [], worktrees: [], error: null, loading: false,
    ...overrides,
  });
  return root;
}

describe('renderLocalGit', () => {
  it('shows a selection prompt and disables refresh without a repo', () => {
    const root = render({ repo: null, path: null });
    expect(root.textContent).toContain('Select a repo');
    expect(root.querySelector<HTMLButtonElement>('.local-git-refresh')?.disabled).toBe(true);
    expect(root.querySelector('.local-git-columns')).toBeNull();
  });

  it('shows the checkout, local branches, their tracking refs and current branch', () => {
    const root = render({ branches: [
      { name: 'main', current: true, upstream: 'origin/main', commit: '1234567890abcdef' },
      { name: 'feature/work', current: false, upstream: null, commit: 'abcdef1234567890' },
    ] });
    expect(root.querySelector('.local-git-checkout')?.textContent).toContain('/workspace/repo');
    expect(root.querySelectorAll('.local-git-item')).toHaveLength(2);
    expect(root.querySelectorAll('.chip')).toHaveLength(1);
    expect(root.querySelector('.chip')?.textContent).toBe('Current');
    expect(root.querySelector('.local-git-upstream')?.textContent).toContain('origin/main');
    expect(root.querySelector('.local-git-commit')?.textContent).toBe('12345678');
    expect(root.querySelector<HTMLButtonElement>('.local-git-refresh')?.disabled).toBe(false);
  });

  it('distinguishes detached and bare worktrees and shows maintenance flags', () => {
    const root = render({ worktrees: [
      { path: '/workspace/detached', branch: null, commit: '1234567890', bare: false, detached: true, locked: true, prunable: false },
      { path: '/workspace/bare', branch: null, commit: '', bare: true, detached: false, locked: false, prunable: true },
    ] });
    expect(root.textContent).toContain('Detached HEAD');
    expect(root.textContent).toContain('Bare');
    expect(root.textContent).toContain('Locked');
    expect(root.textContent).toContain('Prunable');
    expect(root.textContent).toContain('/workspace/detached');
  });

  it('shows ordinary worktree branches', () => {
    const root = render({ worktrees: [
      { path: '/workspace/feature', branch: 'feature/work', commit: 'abcdef1234', bare: false, detached: false, locked: false, prunable: false },
    ] });
    expect(root.querySelector('.local-git-name')?.textContent).toBe('feature/work');
    expect(root.querySelector('.chip')).toBeNull();
  });

  it('exposes loading status and does not show premature empty lists', () => {
    const root = render({ loading: true });
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('.local-git-refresh')?.disabled).toBe(true);
    expect(root.querySelector('.local-git-columns')).toBeNull();
  });

  it('shows failures and permits retry without implying empty results', () => {
    const root = render({ error: 'Checkout unavailable' });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Checkout unavailable');
    expect(root.querySelector<HTMLButtonElement>('.local-git-refresh')?.disabled).toBe(false);
    expect(root.querySelector('.local-git-columns')).toBeNull();
  });

  it('escapes untrusted refs, paths and errors', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const root = render({
      path: payload, error: payload,
      branches: [{ name: payload, current: false, upstream: payload, commit: payload }],
      worktrees: [{ path: payload, branch: payload, commit: payload, bare: false, detached: false, locked: false, prunable: false }],
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.local-git-name')?.textContent).toBe(payload);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(payload);
  });

  it('safely skips malformed external entries', () => {
    const root = render({ branches: [null, {}], worktrees: [null, {}] } as unknown as Partial<LocalGitState>);
    expect(root.textContent).toContain('No local branches.');
    expect(root.textContent).toContain('No local worktrees.');
  });

  it('distinguishes a deleted remote branch from a branch without an upstream', () => {
    const root = render({ branches: [
      { name: 'old', current: false, upstream: 'origin/old', upstreamStatus: 'gone', commit: 'abc' },
      { name: 'local', current: false, upstream: null, upstreamStatus: 'none', commit: 'def' },
    ] });
    expect(root.querySelector('.local-git-gone')?.textContent).toBe('Remote branch gone');
    expect(root.textContent).toContain('No upstream configured');
    expect(root.textContent).toContain('Check remotes fetches and prunes');
  });

  it('shows deletion safeguards and disables actions while pending', () => {
    const root = render({ branches: [
      { name: 'protected', current: false, upstream: null, commit: 'abc', deletionBlockedReason: 'Used by an active run.' },
    ], worktrees: [
      { path: '/other', branch: 'protected', commit: 'abc', bare: false, detached: false, locked: false, prunable: false, deletionBlockedReason: 'Contains uncommitted changes.' },
    ] });
    expect(root.querySelector<HTMLButtonElement>('[data-local-branch]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-local-worktree]')?.disabled).toBe(true);
    expect(root.textContent).toContain('Used by an active run.');
    expect(root.textContent).toContain('Contains uncommitted changes.');
    const pending = render({ pendingAction: 'Checking remotes…' });
    expect(Array.from(pending.querySelectorAll<HTMLButtonElement>('button')).every(button => button.disabled)).toBe(true);
    expect(pending.querySelector('[role="status"]')?.textContent).toBe('Checking remotes…');
  });

  it('links to the selected repo and Config pane', () => {
    const href = render().querySelector('a.app-link')?.getAttribute('href');
    const url = new URL(href ?? '', 'http://localhost');
    expect(url.pathname).toBe('/config');
    expect(url.searchParams.get('repo')).toBe('owner/repo');
    expect(url.searchParams.get('pane')).toBe('local-git');
  });
});
