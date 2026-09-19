import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { getLocalGit, mutateLocalGit } from '../local-git';
import { fetchReviewRequestedPrs } from '../pr-lists';
import { repositoryScope } from './repository-scope';

const run = promisify(execFile);
const localTodos = [{ repo: 'owner/todo-only' }];
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('repositoryScope', () => {
  it('combines configured and todo galleons into one sorted, duplicate-free scope', () => {
    const config = loadConfig({ JIRA_ENABLED: 'false', REPO_PROJECT_MAP: 'owner/z=Z,owner/a=A',
      GITHUB_TOKEN: 'test', GITHUB_PR_AUTHOR: 'captain', GITHUB_REPO: 'owner/z' });
    expect(repositoryScope(config, [...localTodos, ...localTodos, { repo: 'owner/a' }]))
      .toEqual(['owner/a', 'owner/todo-only', 'owner/z']);
  });

  it('removes todo-only galleons when Jira is enabled and supports missing GitHub configuration', () => {
    const config = loadConfig({ JIRA_ENABLED: 'false', REPO_PROJECT_MAP: 'owner/configured=A' });
    expect(repositoryScope(config, localTodos)).toEqual(['owner/configured', 'owner/todo-only']);
    expect(repositoryScope({ ...config, jiraEnabled: true }, localTodos)).toEqual(['owner/configured']);
    expect(repositoryScope(loadConfig({ JIRA_ENABLED: 'false' }), [])).toEqual([]);
  });

  it.each([false, true])('includes todo-only galleons in review fallback only with Jira disabled (Jira %s)', async jiraEnabled => {
    const config = loadConfig({ JIRA_ENABLED: String(jiraEnabled), GITHUB_TOKEN: 'test', GITHUB_PR_AUTHOR: 'captain' });
    const fetchMock = vi.fn(async (url: URL) => new Response(JSON.stringify(url.pathname === '/search/issues'
      ? { items: [], total_count: 0 }
      : [{ number: 12, title: 'Todo change', created_at: '2026-09-19T12:00:00Z',
        requested_reviewers: [{ login: 'captain' }] }])));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchReviewRequestedPrs(config.github, repositoryScope(config, localTodos));

    expect(result.degraded).toBe(false);
    expect(result.prs.map(pr => pr.repo)).toEqual(jiraEnabled ? [] : ['owner/todo-only']);
    expect(fetchMock.mock.calls.some(([url]) => url.pathname === '/repos/owner/todo-only/pulls')).toBe(!jiraEnabled);
  });

  it('allows todo-only local Git reads and cleanup while retaining checkout and worktree safeguards', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'helmsman-scope-')));
    roots.push(root);
    const checkout = join(root, 'todo-only');
    const git = async (...args: string[]) => (await run('git', ['-C', checkout, ...args], { encoding: 'utf8' })).stdout.trim();
    await run('git', ['init', '--initial-branch=main', checkout]);
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial');
    await git('remote', 'add', 'origin', 'https://github.com/owner/todo-only.git');
    await git('branch', 'feature/done');
    const worktree = join(root, 'active');
    await git('worktree', 'add', '-b', 'feature/active', worktree);
    const expectedCommit = await git('rev-parse', 'HEAD');
    const config = loadConfig({ JIRA_ENABLED: 'false' });
    const repos = repositoryScope(config, localTodos);
    const repo = 'owner/todo-only';
    const options = { activeWorktreePaths: () => [worktree] };

    const listing = await getLocalGit(root, repo, repos, options);
    expect(listing.status).toBe(200);
    expect(listing.json.error).toBeNull();
    expect(listing.json.branches).toContainEqual(expect.objectContaining({ name: 'main', deletionBlockedReason: 'Default branches are protected.' }));
    expect(listing.json.worktrees).toContainEqual(expect.objectContaining({ path: worktree, deletionBlockedReason: 'Worktree belongs to an active run.' }));
    expect((await mutateLocalGit(root, repo, repos, { action: 'delete-branch', branch: 'main', expectedCommit, force: true }, options)).status).toBe(409);
    expect((await mutateLocalGit(root, repo, repos, { action: 'delete-worktree', path: worktree, expectedCommit }, options)).status).toBe(409);

    await git('remote', 'set-url', 'origin', 'https://github.com/other/todo-only.git');
    const action = { action: 'delete-branch', branch: 'feature/done', expectedCommit };
    expect((await mutateLocalGit(root, repo, repos, action, options)).json.error).toMatch(/origin does not match/);
    await git('remote', 'set-url', 'origin', 'https://github.com/owner/todo-only.git');
    expect((await mutateLocalGit(root, repo, repos, action, options)).status).toBe(200);
    expect(await git('branch', '--list', 'feature/done')).toBe('');

    const jiraScope = repositoryScope({ ...config, jiraEnabled: true }, localTodos);
    expect((await getLocalGit(root, repo, jiraScope, options)).status).toBe(404);
    expect((await mutateLocalGit(root, repo, jiraScope, action, options)).status).toBe(404);
    const conflicting = repositoryScope(config, [...localTodos, { repo: 'other/todo-only' }]);
    expect((await getLocalGit(root, repo, conflicting, options)).status).toBe(409);
  }, 60_000);
});
