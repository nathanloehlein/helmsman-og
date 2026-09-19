# Codex cost estimates in cmux

Helmsman can add a native cmux sidebar pill for each open Codex session, such as
`Codex surface:9 · $1.24 est`. Each pill belongs to that session's workspace and
surface. The existing Codex activity indicator is preserved.

The estimate uses the same dated Standard short-context API rates as Costs &
Outcomes. It is an API-equivalent estimate, not a subscription bill. Actual API
charges can differ with service tier, long contexts, cache writes or regional
pricing. Unsupported models or missing usage are shown as unknown or partial.
Subagent usage is excluded unless Codex includes it in the parent session's own
reported totals.

## Install

From this checkout, with Node 24 or newer and cmux running:

```sh
npm run cmux:costs:install
```

This installs three named rules in `~/.cmuxterm/automations.json`, preserving
unrelated rules and backing up an existing file. It uses cmux's supported
`agent.hook.*`, `surface.closed` and `surface.moved` events. Codex hook events are
rate-limited to one refresh every three seconds. No cmux application patch,
Codex restart, background daemon or socket-permission change is needed.

Estimates update when a Codex hook arrives, including tool activity and turn
completion. They cannot update during a response before Codex records usage or
sends a hook. Existing sessions can be refreshed immediately:

```sh
npm run cmux:costs
npm run cmux:costs -- --dry-run
```

`--dry-run` reports the labels without changing the sidebar. Session mappings
come from cmux's registry and live surfaces, rather than matching folders or
transcript names. Only exact registered transcripts are read. Cumulative usage
is counted once; model changes use the corresponding rate. Invalid or reset
counters make the estimate partial rather than silently manufacturing a total.

Incremental numeric checkpoints live in `~/.local/state/helmsman/cmux-costs`.
They contain file positions, token totals and model/cost metadata, not prompts,
responses, launch arguments, credentials or transcript text. The refresh command
and its local filesystem reads do not send provider requests.

## Remove or relocate

```sh
npm run cmux:costs:uninstall
```

This removes only Helmsman's cost rules and sidebar pills. To relocate this
checkout or change the Node executable, rerun the installer from the new location.
The automation stores absolute executable and script paths. Existing cmux
security settings still apply; run manual refresh commands from a cmux terminal.

References: [cmux automations](https://github.com/manaflow-ai/cmux/blob/main/docs/automations.md),
[cmux events](https://github.com/manaflow-ai/cmux/blob/main/docs/events.md),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).
