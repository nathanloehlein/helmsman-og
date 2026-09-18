# Live Jira + GitHub Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `loadDashboard()` mock with real data assembled from the Jira and GitHub REST APIs, served to the browser via a Vite dev-server endpoint it polls every 30s.

**Architecture:** A pure assembler (`server/snapshot.ts`) turns raw Jira/GitHub payloads into a `DashboardSnapshot` and is the unit-tested seam. Thin fetch wrappers (`server/jira.ts`, `server/github.ts`) do I/O only. A Vite plugin wires env → fetch → assemble → `GET /api/dashboard`, falling back to the mock payload in a `degraded` mode when creds are missing or a source fails. The browser (`src/data/live.ts` + `main.ts`) polls that endpoint.

**Tech Stack:** TypeScript (strict), Vite 8, Vitest 4, Node global `fetch`. No new runtime dependencies.

## Global Constraints

- TypeScript strict mode; explicit type annotations on all locals, params, and return types; no `any`.
- No secrets in `src/` — every credential is read only inside `server/config.ts`.
- Pure logic files (`src/logic/`) and `src/render.ts` stay unchanged except the single `DailyStats` type change in Task 1.
- New runtime dependencies are not allowed; use Node global `fetch`.
- Tests do no network I/O — assemblers are tested against static fixtures.
- Commit after every task. Conventional Commit messages.

---

### Task 1: Drop token/cost stats from the type, mock, and view

**Files:**
- Modify: `src/types.ts` (`DailyStats`)
- Modify: `src/data/mock.ts` (`STATS` constant)
- Modify: `src/render.ts` (two `stat-row`s)
- Test: existing `src/logic/*.test.ts` (must still pass); `npm run build` typecheck

**Interfaces:**
- Consumes: nothing.
- Produces: `DailyStats = { completedToday: number; awaitingReview: number; avgCycleMinutes: number }`.

- [ ] **Step 1: Edit the type**

In `src/types.ts`, replace the `DailyStats` interface with:

```ts
export interface DailyStats {
  completedToday: number;
  awaitingReview: number;
  avgCycleMinutes: number;
}
```

- [ ] **Step 2: Edit the mock**

In `src/data/mock.ts`, replace the `STATS` constant with:

```ts
const STATS: DailyStats = {
  completedToday: 3,
  awaitingReview: 2,
  avgCycleMinutes: 34,
};
```

- [ ] **Step 3: Edit the view**

In `src/render.ts`, delete these two lines from the stat block:

```html
<div class="stat-row"><span class="stat-label">Tokens spent</span><span class="stat-value">${(data.stats.tokensSpent / 1_000_000).toFixed(1)}M</span></div>
<div class="stat-row"><span class="stat-label">Est. cost</span><span class="stat-value">$${data.stats.estCostUsd.toFixed(2)}</span></div>
```

- [ ] **Step 4: Verify typecheck + tests + build**

Run: `npm run build && npm test`
Expected: PASS, no TS errors referencing `tokensSpent` / `estCostUsd`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/data/mock.ts src/render.ts
git commit -m "refactor: drop unsourceable token/cost stats from DailyStats"
```

---

### Task 2: Raw API shape types

**Files:**
- Create: `server/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JiraIssue`, `JiraHistory`, `JiraChangeItem`, `GithubPr` (raw, normalized shapes used by fetch wrappers and the assembler).

- [ ] **Step 1: Create the file**

```ts
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
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/types.ts
git commit -m "feat: add raw Jira/GitHub payload types"
```

---

### Task 3: Config loader

**Files:**
- Create: `server/config.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface JiraConfig { baseUrl: string; email: string; apiToken: string; project: string; assignee: string; jql: string | null }`
  - `interface GithubConfig { token: string; repo: string; author: string }`
  - `interface AppConfig { jira: JiraConfig | null; github: GithubConfig | null; repoLabel: string }`
  - `loadConfig(env: Record<string, string | undefined>): AppConfig`
  - `buildQueueJql(jira: JiraConfig): string`
  - `buildActiveJql(jira: JiraConfig): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildActiveJql, buildQueueJql, loadConfig } from './config';

const FULL = {
  JIRA_BASE_URL: 'https://x.atlassian.net',
  JIRA_EMAIL: 'a@b.com',
  JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD',
  JIRA_ASSIGNEE: 'me',
  GITHUB_TOKEN: 'gh',
  GITHUB_REPO: 'o/r',
  GITHUB_PR_AUTHOR: 'bot',
};

describe('loadConfig', () => {
  it('populates both sources when all vars present', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.jira?.project).toBe('AIROBUILD');
    expect(cfg.github?.author).toBe('bot');
    expect(cfg.repoLabel).toBe('o/r');
  });

  it('nulls jira when a required jira var is missing', () => {
    const { JIRA_API_TOKEN, ...rest } = FULL;
    expect(loadConfig(rest).jira).toBeNull();
  });

  it('nulls github when a required github var is missing', () => {
    const { GITHUB_TOKEN, ...rest } = FULL;
    expect(loadConfig(rest).github).toBeNull();
  });

  it('defaults repoLabel when github repo absent', () => {
    const { GITHUB_REPO, ...rest } = FULL;
    expect(loadConfig(rest).repoLabel).toBe('backlog-runner');
  });

  it('builds default queue JQL from project + assignee', () => {
    const cfg = loadConfig(FULL);
    expect(buildQueueJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = "me" AND status = Backlog ORDER BY priority',
    );
  });

  it('uses explicit JIRA_JQL override for the queue', () => {
    const cfg = loadConfig({ ...FULL, JIRA_JQL: 'filter = 42' });
    expect(buildQueueJql(cfg.jira!)).toBe('filter = 42');
  });

  it('builds a 7-day active JQL', () => {
    const cfg = loadConfig(FULL);
    expect(buildActiveJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = "me" AND status IN ("In Progress","In Review","Done") AND updated >= -7d ORDER BY updated DESC',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  project: string;
  assignee: string;
  jql: string | null;
}

export interface GithubConfig {
  token: string;
  repo: string;
  author: string;
}

export interface AppConfig {
  jira: JiraConfig | null;
  github: GithubConfig | null;
  repoLabel: string;
}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string | null {
  const value: string | undefined = env[key];
  return value && value.trim() !== '' ? value : null;
}

export function loadConfig(env: Env): AppConfig {
  const baseUrl: string | null = req(env, 'JIRA_BASE_URL');
  const email: string | null = req(env, 'JIRA_EMAIL');
  const apiToken: string | null = req(env, 'JIRA_API_TOKEN');
  const jira: JiraConfig | null =
    baseUrl && email && apiToken
      ? {
          baseUrl,
          email,
          apiToken,
          project: req(env, 'JIRA_PROJECT') ?? 'AIROBUILD',
          assignee: req(env, 'JIRA_ASSIGNEE') ?? 'currentUser()',
          jql: req(env, 'JIRA_JQL'),
        }
      : null;

  const token: string | null = req(env, 'GITHUB_TOKEN');
  const repo: string | null = req(env, 'GITHUB_REPO');
  const author: string | null = req(env, 'GITHUB_PR_AUTHOR');
  const github: GithubConfig | null =
    token && repo && author ? { token, repo, author } : null;

  const repoLabel: string = repo ?? 'backlog-runner';
  return { jira, github, repoLabel };
}

export function buildQueueJql(jira: JiraConfig): string {
  if (jira.jql) return jira.jql;
  return `project = "${jira.project}" AND assignee = "${jira.assignee}" AND status = Backlog ORDER BY priority`;
}

export function buildActiveJql(jira: JiraConfig): string {
  return `project = "${jira.project}" AND assignee = "${jira.assignee}" AND status IN ("In Progress","In Review","Done") AND updated >= -7d ORDER BY updated DESC`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat: env-driven config loader with JQL builders"
```

---

### Task 4: Field mappers (priority, status, PR status, ticket-id parse)

**Files:**
- Create: `server/snapshot.ts` (mappers only in this task)
- Test: `server/snapshot.test.ts`

**Interfaces:**
- Consumes: `JiraIssue`, `GithubPr` from `server/types.ts`; `Priority`, `TicketStatus`, `PrStatus`, `Ticket`, `ShippedPr` from `src/types.ts`.
- Produces:
  - `mapPriority(name: string | null): Priority`
  - `mapStatus(name: string, categoryKey: string): TicketStatus`
  - `mapPrStatus(pr: GithubPr): PrStatus`
  - `parseTicketId(pr: GithubPr): string | null`
  - `issueToTicket(issue: JiraIssue, repo: string): Ticket`
  - `prToShipped(pr: GithubPr): ShippedPr`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  issueToTicket,
  mapPriority,
  mapPrStatus,
  mapStatus,
  parseTicketId,
  prToShipped,
} from './snapshot';
import type { GithubPr, JiraIssue } from './types';

function pr(over: Partial<GithubPr> = {}): GithubPr {
  return {
    number: 10,
    title: 'AIROBUILD-482 add retry',
    headRef: 'feature/AIROBUILD-482-retry',
    authorLogin: 'bot',
    mergedAt: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    reviewDecision: null,
    ...over,
  };
}

function issue(over: Partial<JiraIssue['fields']> = {}): JiraIssue {
  return {
    key: 'AIROBUILD-1',
    fields: {
      summary: 'Do a thing',
      status: { name: 'Backlog', statusCategory: { key: 'new' } },
      priority: { name: 'P2 - Medium' },
      resolutiondate: null,
      ...over,
    },
  };
}

describe('mapPriority', () => {
  it.each([
    ['P1 - Critical', 'P1'],
    ['Highest', 'P1'],
    ['High', 'P1'],
    ['P2 - Medium', 'P2'],
    ['Medium', 'P2'],
    ['P3 - Low', 'P3'],
    ['Low', 'P3'],
    [null, 'P3'],
    ['Weird', 'P3'],
  ])('%s -> %s', (input, expected) => {
    expect(mapPriority(input)).toBe(expected);
  });
});

describe('mapStatus', () => {
  it.each([
    ['Backlog', 'new', 'backlog'],
    ['To Do', 'new', 'backlog'],
    ['In Progress', 'indeterminate', 'in-progress'],
    ['In Review', 'indeterminate', 'in-review'],
    ['Done', 'done', 'done'],
  ])('%s/%s -> %s', (name, cat, expected) => {
    expect(mapStatus(name, cat)).toBe(expected);
  });
});

describe('parseTicketId', () => {
  it('reads id from the title', () => {
    expect(parseTicketId(pr({ title: 'AIROBUILD-482 add retry' }))).toBe('AIROBUILD-482');
  });
  it('falls back to the branch', () => {
    expect(parseTicketId(pr({ title: 'add retry', headRef: 'x/DEVX-9-y' }))).toBe('DEVX-9');
  });
  it('returns null when neither matches', () => {
    expect(parseTicketId(pr({ title: 'add retry', headRef: 'main' }))).toBeNull();
  });
});

describe('mapPrStatus', () => {
  it('merged wins', () => {
    expect(mapPrStatus(pr({ mergedAt: '2026-08-17T01:00:00.000Z' }))).toBe('merged');
  });
  it('changes requested', () => {
    expect(mapPrStatus(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changes-requested');
  });
  it('defaults to in-review', () => {
    expect(mapPrStatus(pr())).toBe('in-review');
  });
});

describe('issueToTicket', () => {
  it('maps fields', () => {
    const t = issueToTicket(issue(), 'o/r');
    expect(t).toEqual({ id: 'AIROBUILD-1', title: 'Do a thing', priority: 'P2', status: 'backlog', repo: 'o/r' });
  });
});

describe('prToShipped', () => {
  it('maps a merged PR', () => {
    const s = prToShipped(pr({ number: 5, title: 'AIROBUILD-3 fix', mergedAt: '2026-08-17T02:00:00.000Z' }));
    expect(s).toEqual({ number: 5, title: 'AIROBUILD-3 fix', ticketId: 'AIROBUILD-3', status: 'merged', openedAt: '2026-08-17T00:00:00.000Z' });
  });
  it('uses em dash when no ticket id', () => {
    expect(prToShipped(pr({ title: 'fix', headRef: 'main' })).ticketId).toBe('—');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot.test.ts`
Expected: FAIL (module has no exports yet).

- [ ] **Step 3: Write minimal implementation**

```ts
import type { GithubPr, JiraIssue } from './types';
import type { Priority, PrStatus, ShippedPr, Ticket, TicketStatus } from '../src/types';

const TICKET_ID_RE: RegExp = /[A-Z][A-Z0-9]+-\d+/;

export function mapPriority(name: string | null): Priority {
  if (!name) return 'P3';
  const upper: string = name.toUpperCase();
  if (upper.startsWith('P1') || upper.includes('HIGHEST') || upper === 'HIGH') return 'P1';
  if (upper.startsWith('P2') || upper.includes('MEDIUM')) return 'P2';
  return 'P3';
}

export function mapStatus(name: string, categoryKey: string): TicketStatus {
  const lower: string = name.toLowerCase();
  if (lower.includes('review')) return 'in-review';
  if (lower.includes('progress')) return 'in-progress';
  if (categoryKey === 'done' || lower === 'done') return 'done';
  if (categoryKey === 'indeterminate') return 'in-progress';
  return 'backlog';
}

export function parseTicketId(pr: GithubPr): string | null {
  const fromTitle: RegExpMatchArray | null = pr.title.match(TICKET_ID_RE);
  if (fromTitle) return fromTitle[0];
  const fromBranch: RegExpMatchArray | null = pr.headRef.match(TICKET_ID_RE);
  return fromBranch ? fromBranch[0] : null;
}

export function mapPrStatus(pr: GithubPr): PrStatus {
  if (pr.mergedAt) return 'merged';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  return 'in-review';
}

export function issueToTicket(issue: JiraIssue, repo: string): Ticket {
  return {
    id: issue.key,
    title: issue.fields.summary,
    priority: mapPriority(issue.fields.priority?.name ?? null),
    status: mapStatus(issue.fields.status.name, issue.fields.status.statusCategory.key),
    repo,
  };
}

export function prToShipped(pr: GithubPr): ShippedPr {
  return {
    number: pr.number,
    title: pr.title,
    ticketId: parseTicketId(pr) ?? '—',
    status: mapPrStatus(pr),
    openedAt: pr.createdAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot.ts server/snapshot.test.ts
git commit -m "feat: Jira/GitHub field mappers"
```

---

### Task 5: Activity feed + current-ticket steps

**Files:**
- Modify: `server/snapshot.ts`
- Modify: `server/snapshot.test.ts`

**Interfaces:**
- Consumes: `JiraIssue`, `GithubPr`; `ActivityEvent`, `WorkStep` from `src/types.ts`; `mapStatus`, `parseTicketId` (Task 4).
- Produces:
  - `buildActivity(activeIssues: JiraIssue[], prs: GithubPr[]): ActivityEvent[]` (newest-first, capped at 12)
  - `buildSteps(current: JiraIssue, prs: GithubPr[]): WorkStep[]`

- [ ] **Step 1: Write the failing test (append to `server/snapshot.test.ts`)**

```ts
import { buildActivity, buildSteps } from './snapshot';

const CURRENT: JiraIssue = {
  key: 'AIROBUILD-482',
  fields: {
    summary: 'Add retry',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'P2 - Medium' },
    resolutiondate: null,
  },
  changelog: {
    histories: [
      { created: '2026-08-17T00:00:00.000Z', items: [{ field: 'status', fromString: 'Backlog', toString: 'In Progress' }] },
    ],
  },
};

describe('buildActivity', () => {
  it('merges status transitions and PR events, newest first', () => {
    const prs: GithubPr[] = [
      { number: 7, title: 'AIROBUILD-482 retry', headRef: 'f/AIROBUILD-482', authorLogin: 'bot', mergedAt: '2026-08-17T03:00:00.000Z', createdAt: '2026-08-17T01:00:00.000Z', reviewDecision: null },
    ];
    const feed = buildActivity([CURRENT], prs);
    expect(feed[0].time).toBe('2026-08-17T03:00:00.000Z');
    expect(feed[0].text).toContain('merged');
    expect(feed[0].accent).toBe(true);
    const times = feed.map((e) => e.time);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('caps at 12 events', () => {
    const many: JiraIssue[] = Array.from({ length: 20 }, (_, i) => ({
      key: `K-${i}`,
      fields: { summary: 's', status: { name: 'Done', statusCategory: { key: 'done' } }, priority: null, resolutiondate: null },
      changelog: { histories: [{ created: `2026-08-1${i % 9}T00:00:00.000Z`, items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] }] },
    }));
    expect(buildActivity(many, []).length).toBe(12);
  });
});

describe('buildSteps', () => {
  it('turns transitions into done steps and marks the tail active while in progress', () => {
    const steps = buildSteps(CURRENT, []);
    expect(steps[0].state).toBe('done');
    expect(steps[steps.length - 1].state).toBe('active');
  });

  it('adds a step for a linked PR', () => {
    const prs: GithubPr[] = [
      { number: 9, title: 'AIROBUILD-482 retry', headRef: 'f/AIROBUILD-482', authorLogin: 'bot', mergedAt: null, createdAt: '2026-08-17T02:00:00.000Z', reviewDecision: null },
    ];
    const steps = buildSteps(CURRENT, prs);
    expect(steps.some((s) => s.text.includes('#9'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot.test.ts`
Expected: FAIL (`buildActivity`/`buildSteps` not exported).

- [ ] **Step 3: Write minimal implementation (append to `server/snapshot.ts`)**

```ts
import type { ActivityEvent, WorkStep } from '../src/types';

const ACTIVITY_CAP: number = 12;

function statusTransitions(issue: JiraIssue): { time: string; to: string }[] {
  const histories: JiraHistoryLike[] = issue.changelog?.histories ?? [];
  return histories
    .flatMap((h) =>
      h.items
        .filter((it) => it.field === 'status' && it.toString)
        .map((it) => ({ time: h.created, to: it.toString as string })),
    );
}

type JiraHistoryLike = { created: string; items: { field: string; toString: string | null }[] };

export function buildActivity(activeIssues: JiraIssue[], prs: GithubPr[]): ActivityEvent[] {
  const jiraEvents: ActivityEvent[] = activeIssues.flatMap((issue) =>
    statusTransitions(issue).map((t) => ({
      time: t.time,
      text: `<b>${issue.key}</b> &rarr; ${t.to}`,
      accent: true,
    })),
  );

  const prEvents: ActivityEvent[] = prs.flatMap((pr) => {
    const id: string = parseTicketId(pr) ?? `PR #${pr.number}`;
    const events: ActivityEvent[] = [
      { time: pr.createdAt, text: `opened PR #${pr.number} (${id})`, accent: false },
    ];
    if (pr.mergedAt) {
      events.push({ time: pr.mergedAt, text: `<b>${id}</b> PR #${pr.number} merged`, accent: true });
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      events.push({ time: pr.createdAt, text: `PR #${pr.number} changes requested`, accent: false });
    }
    return events;
  });

  return [...jiraEvents, ...prEvents]
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, ACTIVITY_CAP);
}

export function buildSteps(current: JiraIssue, prs: GithubPr[]): WorkStep[] {
  const transitions: { time: string; to: string }[] = statusTransitions(current);
  const steps: WorkStep[] = transitions.map((t) => ({
    time: t.time,
    state: 'done',
    text: `Transitioned to <b>${t.to}</b>`,
  }));

  const linked: GithubPr | undefined = prs.find((pr) => parseTicketId(pr) === current.key);
  if (linked) {
    steps.push({ time: linked.createdAt, state: 'done', text: `Opened <b>PR #${linked.number}</b>` });
  }

  const stillInProgress: boolean = current.fields.status.name.toLowerCase().includes('progress');
  if (stillInProgress && steps.length > 0) {
    steps[steps.length - 1] = { ...steps[steps.length - 1]!, state: 'active' };
  }
  return steps;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot.ts server/snapshot.test.ts
git commit -m "feat: derive activity feed and current-ticket steps from changelog + PRs"
```

---

### Task 6: Stats, throughput, and top-level assembleSnapshot

**Files:**
- Modify: `server/snapshot.ts`
- Modify: `server/snapshot.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–5; `DailyStats`, `DashboardSnapshot`, `Ticket` from `src/types.ts`/`src/data/mock.ts`.
- Produces:
  - `computeStats(activeIssues: JiraIssue[], now: Date): DailyStats`
  - `buildThroughput7d(activeIssues: JiraIssue[], now: Date): number[]` (length 7, oldest→newest)
  - `assembleSnapshot(input: SnapshotInput): DashboardSnapshot` where
    `interface SnapshotInput { queueIssues: JiraIssue[]; activeIssues: JiraIssue[]; prs: GithubPr[]; repo: string; now: Date }`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { assembleSnapshot, buildThroughput7d, computeStats } from './snapshot';
import type { DashboardSnapshot } from '../src/data/mock';

function doneIssue(key: string, resolved: string): JiraIssue {
  return {
    key,
    fields: { summary: key, status: { name: 'Done', statusCategory: { key: 'done' } }, priority: null, resolutiondate: resolved },
    changelog: { histories: [
      { created: '2026-08-17T09:00:00.000Z', items: [{ field: 'status', fromString: 'Backlog', toString: 'In Progress' }] },
      { created: resolved, items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
    ] },
  };
}

describe('computeStats', () => {
  it('counts done-today, awaiting-review, and average cycle minutes', () => {
    const now = new Date('2026-08-17T12:00:00.000Z');
    const active: JiraIssue[] = [
      doneIssue('D-1', '2026-08-17T10:00:00.000Z'),
      { key: 'R-1', fields: { summary: 'r', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, priority: null, resolutiondate: null } },
    ];
    const stats = computeStats(active, now);
    expect(stats.completedToday).toBe(1);
    expect(stats.awaitingReview).toBe(1);
    expect(stats.avgCycleMinutes).toBe(60);
  });
});

describe('buildThroughput7d', () => {
  it('returns 7 daily counts oldest to newest', () => {
    const now = new Date('2026-08-17T12:00:00.000Z');
    const active: JiraIssue[] = [doneIssue('D-1', '2026-08-17T10:00:00.000Z'), doneIssue('D-2', '2026-08-17T11:00:00.000Z')];
    const t = buildThroughput7d(active, now);
    expect(t.length).toBe(7);
    expect(t[6]).toBe(2);
  });
});

describe('assembleSnapshot', () => {
  it('produces a full snapshot and a synthetic idle ticket when none in progress', () => {
    const now = new Date('2026-08-17T12:00:00.000Z');
    const snap: DashboardSnapshot = assembleSnapshot({
      queueIssues: [{ key: 'Q-1', fields: { summary: 'queued', status: { name: 'Backlog', statusCategory: { key: 'new' } }, priority: { name: 'P1' }, resolutiondate: null } }],
      activeIssues: [],
      prs: [],
      repo: 'o/r',
      now,
    });
    expect(snap.queue.length).toBe(1);
    expect(snap.repo).toBe('o/r');
    expect(snap.currentTicket.status).toBe('in-progress');
    expect(snap.steps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/snapshot.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation (append)**

```ts
import type { DailyStats } from '../src/types';
import type { DashboardSnapshot } from '../src/data/mock';

const DAY_MS: number = 24 * 60 * 60 * 1000;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function isDone(issue: JiraIssue): boolean {
  return mapStatus(issue.fields.status.name, issue.fields.status.statusCategory.key) === 'done';
}

function cycleMinutes(issue: JiraIssue): number | null {
  const histories: JiraHistory[] = issue.changelog?.histories ?? [];
  const start: JiraHistory | undefined = histories.find((h) =>
    h.items.some((it) => it.field === 'status' && (it.toString ?? '').toLowerCase().includes('progress')),
  );
  if (!start || !issue.fields.resolutiondate) return null;
  const ms: number = new Date(issue.fields.resolutiondate).getTime() - new Date(start.created).getTime();
  return ms > 0 ? Math.round(ms / 60000) : null;
}

export function computeStats(activeIssues: JiraIssue[], now: Date): DailyStats {
  const today: string = now.toISOString().slice(0, 10);
  const done: JiraIssue[] = activeIssues.filter(isDone);
  const completedToday: number = done.filter((i) => i.fields.resolutiondate && dayKey(i.fields.resolutiondate) === today).length;
  const awaitingReview: number = activeIssues.filter(
    (i) => mapStatus(i.fields.status.name, i.fields.status.statusCategory.key) === 'in-review',
  ).length;
  const cycles: number[] = done.map(cycleMinutes).filter((n): n is number => n !== null);
  const avgCycleMinutes: number = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : 0;
  return { completedToday, awaitingReview, avgCycleMinutes };
}

export function buildThroughput7d(activeIssues: JiraIssue[], now: Date): number[] {
  const buckets: number[] = [0, 0, 0, 0, 0, 0, 0];
  const end: number = now.getTime();
  for (const issue of activeIssues) {
    if (!isDone(issue) || !issue.fields.resolutiondate) continue;
    const age: number = end - new Date(issue.fields.resolutiondate).getTime();
    const dayIndex: number = 6 - Math.floor(age / DAY_MS);
    if (dayIndex >= 0 && dayIndex <= 6) buckets[dayIndex]++;
  }
  return buckets;
}

export interface SnapshotInput {
  queueIssues: JiraIssue[];
  activeIssues: JiraIssue[];
  prs: GithubPr[];
  repo: string;
  now: Date;
}

function idleTicket(repo: string): Ticket {
  return { id: '—', title: 'Idle — no ticket in progress', priority: 'P3', status: 'in-progress', repo };
}

export function assembleSnapshot(input: SnapshotInput): DashboardSnapshot {
  const { queueIssues, activeIssues, prs, repo, now } = input;
  const current: JiraIssue | undefined = activeIssues.find(
    (i) => mapStatus(i.fields.status.name, i.fields.status.statusCategory.key) === 'in-progress',
  );
  return {
    repo,
    queue: queueIssues.map((i) => issueToTicket(i, repo)),
    currentTicket: current ? issueToTicket(current, repo) : idleTicket(repo),
    steps: current ? buildSteps(current, prs) : [],
    shipped: prs.map(prToShipped),
    activity: buildActivity(activeIssues, prs),
    stats: computeStats(activeIssues, now),
    throughput7d: buildThroughput7d(activeIssues, now),
  };
}
```

Note: add `Ticket` to the existing `src/types` import at the top of `server/snapshot.ts` if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/snapshot.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot.ts server/snapshot.test.ts
git commit -m "feat: stats, throughput, and assembleSnapshot seam"
```

---

### Task 7: Jira + GitHub fetch wrappers

**Files:**
- Create: `server/jira.ts`
- Create: `server/github.ts`

**Interfaces:**
- Consumes: `JiraConfig`, `GithubConfig` (Task 3); `buildQueueJql`, `buildActiveJql` (Task 3); `JiraIssue`, `GithubPr` (Task 2).
- Produces:
  - `fetchQueueIssues(jira: JiraConfig): Promise<JiraIssue[]>`
  - `fetchActiveIssues(jira: JiraConfig): Promise<JiraIssue[]>`
  - `fetchAuthoredPrs(github: GithubConfig): Promise<GithubPr[]>`

These are thin I/O wrappers with no branching logic, so they are not unit-tested (per the spec). They are exercised end-to-end in Task 9's manual verification.

- [ ] **Step 1: Create `server/jira.ts`**

```ts
import type { JiraConfig } from './config';
import { buildActiveJql, buildQueueJql } from './config';
import type { JiraIssue } from './types';

const FIELDS: string = 'summary,status,priority,resolutiondate';

async function search(jira: JiraConfig, jql: string, expandChangelog: boolean): Promise<JiraIssue[]> {
  const url: URL = new URL('/rest/api/3/search/jql', jira.baseUrl);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('maxResults', '100');
  if (expandChangelog) url.searchParams.set('expand', 'changelog');

  const auth: string = Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
  const res: Response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
  const body: { issues?: JiraIssue[] } = await res.json();
  return body.issues ?? [];
}

export function fetchQueueIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  return search(jira, buildQueueJql(jira), false);
}

export function fetchActiveIssues(jira: JiraConfig): Promise<JiraIssue[]> {
  return search(jira, buildActiveJql(jira), true);
}
```

- [ ] **Step 2: Create `server/github.ts`**

```ts
import type { GithubConfig } from './config';
import type { GithubPr, PrReviewDecision } from './types';

interface RawPr {
  number: number;
  title: string;
  head: { ref: string };
  user: { login: string } | null;
  merged_at: string | null;
  created_at: string;
}

interface RawReview {
  state: string;
  submitted_at: string | null;
}

const API: string = 'https://api.github.com';

function headers(github: GithubConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function latestReviewDecision(github: GithubConfig, prNumber: number): Promise<PrReviewDecision> {
  const res: Response = await fetch(`${API}/repos/${github.repo}/pulls/${prNumber}/reviews?per_page=100`, {
    headers: headers(github),
  });
  if (!res.ok) return null;
  const reviews: RawReview[] = await res.json();
  const decisive: RawReview[] = reviews.filter((r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED');
  const last: RawReview | undefined = decisive[decisive.length - 1];
  if (!last) return 'REVIEW_REQUIRED';
  return last.state === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVED';
}

export async function fetchAuthoredPrs(github: GithubConfig): Promise<GithubPr[]> {
  const res: Response = await fetch(
    `${API}/repos/${github.repo}/pulls?state=all&sort=updated&direction=desc&per_page=20`,
    { headers: headers(github) },
  );
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const raw: RawPr[] = await res.json();
  const mine: RawPr[] = raw.filter((pr) => pr.user?.login === github.author).slice(0, 8);
  return Promise.all(
    mine.map(async (pr): Promise<GithubPr> => ({
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      authorLogin: pr.user?.login ?? '',
      mergedAt: pr.merged_at,
      createdAt: pr.created_at,
      reviewDecision: pr.merged_at ? null : await latestReviewDecision(github, pr.number),
    })),
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/jira.ts server/github.ts
git commit -m "feat: Jira search and GitHub PR fetch wrappers"
```

---

### Task 8: Vite endpoint plugin with degraded fallback

**Files:**
- Create: `server/dashboard-endpoint.ts` (Helmsman: config → fetch → assemble, with per-source fallback)
- Create: `vite-plugin-dashboard.ts`
- Modify: `vite.config.ts` (create if absent) to register the plugin
- Test: `server/dashboard-endpoint.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 3); fetch wrappers (Task 7); `assembleSnapshot` (Task 6); `loadDashboard` mock (`src/data/mock.ts`).
- Produces:
  - `interface DashboardResponse { snapshot: DashboardSnapshot; degraded: string[] }`
  - `buildDashboardResponse(env: Record<string, string | undefined>, now: Date, deps?: Deps): Promise<DashboardResponse>` where `Deps` allows injecting the four fetchers + mock for testing.
  - `dashboardPlugin(): Plugin` (Vite) serving `GET /api/dashboard`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildDashboardResponse } from './dashboard-endpoint';

const NOW = new Date('2026-08-17T12:00:00.000Z');

const FULL_ENV = {
  JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD', JIRA_ASSIGNEE: 'me',
  GITHUB_TOKEN: 'gh', GITHUB_REPO: 'o/r', GITHUB_PR_AUTHOR: 'bot',
};

const OK_DEPS = {
  fetchQueueIssues: async () => [{ key: 'Q-1', fields: { summary: 'q', status: { name: 'Backlog', statusCategory: { key: 'new' } }, priority: { name: 'P1' }, resolutiondate: null } }],
  fetchActiveIssues: async () => [],
  fetchAuthoredPrs: async () => [],
  loadMock: async () => { throw new Error('mock should not be called'); },
};

describe('buildDashboardResponse', () => {
  it('returns live data with empty degraded list when all sources succeed', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, OK_DEPS);
    expect(r.degraded).toEqual([]);
    expect(r.snapshot.queue[0].id).toBe('Q-1');
  });

  it('degrades to mock queue when Jira throws, keeps GitHub', async () => {
    const r = await buildDashboardResponse(FULL_ENV, NOW, {
      ...OK_DEPS,
      fetchQueueIssues: async () => { throw new Error('boom'); },
      fetchActiveIssues: async () => { throw new Error('boom'); },
      loadMock: async () => (await import('../src/data/mock')).loadDashboard(),
    });
    expect(r.degraded).toContain('jira');
    expect(r.snapshot.shipped).toEqual([]);
  });

  it('fully degrades to mock when nothing is configured', async () => {
    const r = await buildDashboardResponse({}, NOW, {
      ...OK_DEPS,
      loadMock: async () => (await import('../src/data/mock')).loadDashboard(),
    });
    expect(r.degraded).toContain('jira');
    expect(r.degraded).toContain('github');
    expect(r.snapshot.queue.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/dashboard-endpoint.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `server/dashboard-endpoint.ts`**

```ts
import type { DashboardSnapshot } from '../src/data/mock';
import type { GithubPr, JiraIssue } from './types';
import type { GithubConfig, JiraConfig } from './config';
import { loadConfig } from './config';
import { assembleSnapshot } from './snapshot';
import { fetchActiveIssues, fetchQueueIssues } from './jira';
import { fetchAuthoredPrs } from './github';
import { loadDashboard } from '../src/data/mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
}

export interface Deps {
  fetchQueueIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchActiveIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchAuthoredPrs: (github: GithubConfig) => Promise<GithubPr[]>;
  loadMock: () => Promise<DashboardSnapshot>;
}

const DEFAULT_DEPS: Deps = {
  fetchQueueIssues,
  fetchActiveIssues,
  fetchAuthoredPrs,
  loadMock: loadDashboard,
};

export async function buildDashboardResponse(
  env: Record<string, string | undefined>,
  now: Date,
  deps: Deps = DEFAULT_DEPS,
): Promise<DashboardResponse> {
  const config = loadConfig(env);
  const degraded: string[] = [];
  const mock: DashboardSnapshot = await deps.loadMock();

  let queueIssues: JiraIssue[] = [];
  let activeIssues: JiraIssue[] = [];
  let prs: GithubPr[] = [];

  if (config.jira) {
    try {
      [queueIssues, activeIssues] = await Promise.all([
        deps.fetchQueueIssues(config.jira),
        deps.fetchActiveIssues(config.jira),
      ]);
    } catch {
      degraded.push('jira');
    }
  } else {
    degraded.push('jira');
  }

  if (config.github) {
    try {
      prs = await deps.fetchAuthoredPrs(config.github);
    } catch {
      degraded.push('github');
    }
  } else {
    degraded.push('github');
  }

  const jiraDegraded: boolean = degraded.includes('jira');
  const githubDegraded: boolean = degraded.includes('github');

  const snapshot: DashboardSnapshot = assembleSnapshot({
    queueIssues,
    activeIssues,
    prs,
    repo: config.repoLabel,
    now,
  });

  if (jiraDegraded) {
    snapshot.queue = mock.queue;
    snapshot.currentTicket = mock.currentTicket;
    snapshot.steps = mock.steps;
    snapshot.stats = mock.stats;
    snapshot.throughput7d = mock.throughput7d;
  }
  if (githubDegraded) {
    snapshot.shipped = jiraDegraded ? mock.shipped : [];
  }
  if (jiraDegraded && githubDegraded) {
    snapshot.activity = mock.activity;
  }

  return { snapshot, degraded };
}
```

- [ ] **Step 4: Write `vite-plugin-dashboard.ts`**

```ts
import type { Plugin, ViteDevServer } from 'vite';
import { buildDashboardResponse } from './server/dashboard-endpoint';

export function dashboardPlugin(): Plugin {
  return {
    name: 'backlog-runner-dashboard',
    configureServer(server: ViteDevServer): void {
      server.middlewares.use('/api/dashboard', (_req, res) => {
        buildDashboardResponse(process.env, new Date())
          .then((payload) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(payload));
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          });
      });
    },
  };
}
```

- [ ] **Step 5: Create/modify `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { dashboardPlugin } from './vite-plugin-dashboard';

export default defineConfig({
  plugins: [dashboardPlugin()],
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/dashboard-endpoint.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/dashboard-endpoint.ts server/dashboard-endpoint.test.ts vite-plugin-dashboard.ts vite.config.ts
git commit -m "feat: /api/dashboard endpoint with per-source degraded fallback"
```

---

### Task 9: Client fetch, 30s poll, degraded banner, and docs

**Files:**
- Create: `src/data/live.ts`
- Modify: `src/main.ts`
- Modify: `src/render.ts` (accept + render an optional degraded banner)
- Modify: `src/style.css` (banner style)
- Create: `.env.example`
- Modify: `.gitignore` (ensure `.env` ignored)
- Modify: `README.md` (replace the "wiring" section's future tense with setup steps)

**Interfaces:**
- Consumes: `buildDashboardResponse` response shape (`{ snapshot, degraded }`) over HTTP; `renderDashboard` (Task 1).
- Produces: `loadDashboard(): Promise<DashboardResponse>` (client version), `POLL_MS` constant.

- [ ] **Step 1: Create `src/data/live.ts`**

```ts
import type { DashboardSnapshot } from './mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
}

export const POLL_MS: number = 30_000;

export async function loadDashboard(): Promise<DashboardResponse> {
  const res: Response = await fetch('/api/dashboard', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`dashboard endpoint ${res.status}`);
  return res.json() as Promise<DashboardResponse>;
}
```

- [ ] **Step 2: Rewrite `src/main.ts` to poll**

```ts
import './style.css';
import { loadDashboard, POLL_MS, type DashboardResponse } from './data/live';
import { renderDashboard } from './render';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app root element');

async function tick(target: HTMLDivElement): Promise<void> {
  try {
    const { snapshot, degraded }: DashboardResponse = await loadDashboard();
    renderDashboard(target, snapshot, new Date(), degraded);
  } catch {
    // keep last-good render on transient poll failure
  }
}

void tick(root);
setInterval(() => void tick(root), POLL_MS);
```

- [ ] **Step 3: Extend `renderDashboard` signature to show a degraded banner**

In `src/render.ts`, change the signature and prepend a banner when degraded:

```ts
export function renderDashboard(
  root: HTMLElement,
  data: DashboardSnapshot,
  now: Date,
  degraded: string[] = [],
): void {
```

Immediately before `root.innerHTML = \`` build the banner and inject it as the first child of `.wrap`:

```ts
  const banner: string =
    degraded.length > 0
      ? `<div class="degraded-banner">Showing sample data for: ${degraded.join(', ')} — check server credentials.</div>`
      : '';
```

Then insert `${banner}` as the first line inside `<div class="wrap">`.

- [ ] **Step 4: Add banner style to `src/style.css`**

```css
.degraded-banner {
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--accent);
  font-size: 13px;
}
```

- [ ] **Step 5: Create `.env.example`**

```
JIRA_BASE_URL=https://godaddy-corp.atlassian.net
JIRA_EMAIL=you@godaddy.com
JIRA_API_TOKEN=
JIRA_PROJECT=AIROBUILD
JIRA_ASSIGNEE=currentUser()
# JIRA_JQL=  # optional full override of the backlog-queue query
GITHUB_TOKEN=
GITHUB_REPO=nathanloehlein/backlog-runner
GITHUB_PR_AUTHOR=nathanloehlein
```

- [ ] **Step 6: Ensure `.gitignore` ignores `.env`**

Confirm `.gitignore` contains a `.env` line (add it if missing). `.env.example` stays tracked.

- [ ] **Step 7: Update `README.md`**

Replace the future-tense "Wiring this dashboard to the real thing" paragraph with concrete steps: copy `.env.example` to `.env`, fill Jira API token + GitHub PAT, `npm run dev`, note the 30s poll and the degraded banner behavior when creds are absent.

- [ ] **Step 8: Verify end-to-end**

Run: `npm run build && npm test`
Expected: PASS. Then `npm run dev`, load the page:
- With no `.env`: page renders mock data + degraded banner naming `jira, github`.
- With real `.env`: queue/current/shipped/activity reflect live AIROBUILD + GitHub data; banner absent.

- [ ] **Step 9: Commit**

```bash
git add src/data/live.ts src/main.ts src/render.ts src/style.css .env.example .gitignore README.md
git commit -m "feat: poll /api/dashboard every 30s with degraded banner"
```

---

## Self-Review

**Spec coverage:**
- Architecture module layout → Tasks 2–9 (all files present). ✓
- Panel mapping table → Tasks 4 (mappers), 5 (activity/steps), 6 (stats/throughput/assemble). ✓
- `DailyStats` type change + render drop → Task 1. ✓
- Secrets/`.env`/`.env.example` → Tasks 3, 9. ✓
- Error handling (never-500, per-source, keep-last-good) → Task 8 (per-source), Task 9 Step 2 (keep-last-good), Task 8 Step 4 (plugin catch). ✓
- Testing (pure assembler fixtures, thin wrappers untested) → Tasks 4–6, 8; wrappers Task 7 untested by design. ✓
- Priority + status mapping tables → Task 4. ✓
- Out-of-scope items (deploy, writes, websockets) → not planned. ✓

**Placeholder scan:** no TBD/TODO in tasks; every code step has real code. ✓

**Type consistency:** `DashboardSnapshot` imported from `src/data/mock`; `DashboardResponse` defined identically in `server/dashboard-endpoint.ts` and `src/data/live.ts` (server-side response is serialized then re-typed client-side — intentional duplication across the HTTP boundary, not a shared import); mapper names (`mapStatus`, `parseTicketId`, `issueToTicket`, `assembleSnapshot`) consistent across Tasks 4–8. ✓

**Note for implementer:** `server/` is Node-side TypeScript run by Vite/Vitest; it imports a few types from `src/`. No new tsconfig needed — Vitest and Vite both transpile per-file. If `npx tsc --noEmit` does not already include `server/`, add `"server"` to the `include` array in `tsconfig.json` during Task 2.
