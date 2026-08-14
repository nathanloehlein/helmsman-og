# Backlog Runner

Dashboard prototype for a Jira-backlog-driven coding agent: current task, priority
queue, PR history, and a live activity feed. Built to visualize the "agent claims
a ticket, implements it, opens a PR, picks the next one" loop with a human
approval gate before merge.

## Stack

TypeScript (strict) + Vite, no runtime framework. Logic (`src/logic/`) is pure and
unit-tested with Vitest; `src/render.ts` is the only thing that touches the DOM.

## Data

`src/data/mock.ts` is the seam. It returns a `DashboardSnapshot` from static mock
data today — swap its implementation for real calls against the Jira and GitHub
REST APIs and the rest of the app is unchanged.

## Commands

```bash
npm install
npm run dev      # dev server
npm run build    # production build to dist/
npm test         # vitest
```
