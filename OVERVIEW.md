# Helmsman

Helmsman is a local control plane for AI coding and code-review agents. It turns
Jira tickets, local todos, and custom tasks into supervised runs, with live output,
review gates, and a dashboard for tracking progress and outcomes.

## Main features

- **Coding and review agents:** Run Codex or Claude Code to implement tasks, review
  existing PRs, or address feedback on an existing branch.
- **Review before publication:** New coding runs require independent approval of
  the final commit before Helmsman pushes it and opens a PR. Existing-PR feedback
  runs follow a separate path. Merging remains a human action.
- **Live supervision:** Follow logs, stop runs, inspect history, retry failures,
  and recover eligible interrupted work.
- **Automated intake:** Opt into backlog auto-claim, Slack/GitHub review watchers,
  or authenticated webhooks.
- **Batch campaigns:** Import CSV or JSONL tasks, preview destinations, and run
  phases with concurrency controls, pause/stop, and failed-task retries.
- **Agent Questions:** Answer questions from running agents directly in the UI.
- **Costs & Outcomes:** Track reported usage, separate cost estimates, PR outcomes,
  and evidence-based assessments of whether work achieved its goal.
- **Execution options:** Use local background processes, cmux, WezTerm, or optional
  restricted Docker stages, with per-run workspaces and saved execution settings.
- **Customizable dashboard:** Scope views by repository, choose light or dark
  themes, and toggle Pirate terminology.

Helmsman uses TypeScript, Vite, a Node.js server, and SQLite. See the
[README](README.md) for setup and the [workflow diagrams](docs/helmsman-process.html)
for the execution flow.
