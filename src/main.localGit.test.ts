import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';
import type { LocalGitResponse } from './data/localGit';

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const views: DashboardView[] = [];
const listing = (repo = 'org/a'): LocalGitResponse => ({
  repo, path: `/repos/${repo}`, error: null,
  branches: [{ name: 'topic', current: false, upstream: 'origin/topic', upstreamStatus: 'gone', commit: 'abc123' }],
  worktrees: [{ path: '/repos/topic', branch: 'topic', commit: 'abc123', bare: false, detached: false, locked: false, prunable: false }],
});

async function setup(post: (body: Record<string, unknown>) => Response | Promise<Response> = body => json({ ...listing(String(body.repo)), branches: [], worktrees: [] })) {
  window.history.replaceState(null, '', '/config?repo=org/a');
  const snapshot = await loadDashboard();
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      if (url.pathname !== '/api/repo/local') throw new Error('Unexpected write');
      return post(body);
    }
    reads.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/a', 'org/b'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/a', 'org/b'], selectedRepo: url.searchParams.get('repo'), jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/repo/local') return json(listing(url.searchParams.get('repo') ?? 'org/a'));
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-local-branch="topic"]')?.disabled).toBe(false));
  const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
  return { root, writes, reads, click };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
});
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('local Git actions', () => {
  it('requires explicit target confirmation and defaults to safe branch deletion', async () => {
    const { root, writes, click } = await setup();
    click('[data-local-branch="topic"]');
    expect(root.querySelector('.local-git-confirmation')?.textContent).toContain('Delete local branch topic?');
    expect(root.querySelector<HTMLInputElement>('.local-git-force')?.checked).toBe(false);
    expect(writes).toEqual([]);
    click('.local-git-cancel');
    expect(root.querySelector('.local-git-confirmation')).toBeNull();
    expect(writes).toEqual([]);
    click('[data-local-branch="topic"]');
    click('.local-git-confirm-delete');
    await vi.waitFor(() => expect(writes).toEqual([{ repo: 'org/a', action: 'delete-branch', branch: 'topic', expectedCommit: 'abc123', force: false }]));
    await vi.waitFor(() => expect(root.querySelector('[data-local-branch]')).toBeNull());
  });

  it('shows Git refusal and only forces after an explicit checkbox selection', async () => {
    const { root, writes, click } = await setup(body => body.force ? json({ ...listing(), branches: [] }) : json({ ...listing(), error: 'Branch is not fully merged. Choose unmerged deletion to proceed.' }, 409));
    click('[data-local-branch="topic"]');
    click('.local-git-confirm-delete');
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('not fully merged'));
    click('[data-local-branch="topic"]');
    root.querySelector<HTMLInputElement>('.local-git-force')!.checked = true;
    click('.local-git-confirm-delete');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.force).toBe(false);
    expect(writes[1]?.force).toBe(true);
  });

  it('names the worktree directory and sends its pinned commit without force', async () => {
    const { root, writes, click } = await setup();
    click('[data-local-worktree="/repos/topic"]');
    expect(root.querySelector('.local-git-confirmation')?.textContent).toContain('/repos/topic');
    expect(root.querySelector('.local-git-force')).toBeNull();
    click('.local-git-confirm-delete');
    await vi.waitFor(() => expect(writes).toEqual([{ repo: 'org/a', action: 'delete-worktree', path: '/repos/topic', expectedCommit: 'abc123' }]));
  });

  it('keeps ordinary refresh local and checks remotes only on demand', async () => {
    const { root, writes, reads, click } = await setup();
    const initial = reads.filter(path => path === '/api/repo/local').length;
    click('.local-git-actions > .local-git-refresh:not(.local-git-check-remotes)');
    await vi.waitFor(() => expect(reads.filter(path => path === '/api/repo/local')).toHaveLength(initial + 1));
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.local-git-check-remotes')?.disabled).toBe(false));
    expect(writes).toEqual([]);
    click('.local-git-check-remotes');
    await vi.waitFor(() => expect(writes).toEqual([{ repo: 'org/a', action: 'refresh-remotes' }]));
  });

  it('disables controls during a write and ignores its result after changing repository', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const { root, writes, click } = await setup(() => pending);
    click('[data-local-branch="topic"]');
    click('.local-git-confirm-delete');
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('.local-git-panel button')).every(button => button.disabled)).toBe(true);
    expect(writes).toHaveLength(1);
    const select = root.querySelector<HTMLSelectElement>('.repo-select')!;
    select.value = 'org/b';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.querySelector('.local-git-checkout')?.textContent).toContain('/repos/org/b'));
    finish(json({ ...listing('org/a'), branches: [], error: 'Old repository result' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('.local-git-checkout')?.textContent).toContain('/repos/org/b');
    expect(root.textContent).not.toContain('Old repository result');
  });
});
