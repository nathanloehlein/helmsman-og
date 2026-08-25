# Backlog Runner — Design

Committed visual world: **Agent Jackfield** — the command center read as a studio patch-bay *normalling schedule*. Every agent run is a numbered lane tied to its ticket/PR by one amber link line; the line's **stroke pattern**, never its colour, carries state. The former **Tactical HUD** (cyan-glow mission-control) and the original light dashboard are anti-reference, not authority. Seed: `operate/direction a04e52f5`, form `operate-b-normalled-jackfield` (user-picked over the rolled mission-control assignment).

## Use scene → dark

An ops board an operator keeps open on a second monitor, glanced at from across the room and leaned into to launch/stop/review. Black glass is chosen from that scene. Dark is the only committed world.

## Tokens

Defined on `:root` in `src/style.css` (`color-scheme: dark`).

| Role | Value |
| --- | --- |
| Page gutter / base | `--gutter #050507` / `--bg #07070a` (the deck is a bordered max-width slab with dark edge gutters — nothing spans full width) |
| Panels | `--panel #0b0c10`, `--panel-2 #0f1116`, `--panel-hi #14161d` |
| Signal amber (the ONE accent) | `--accent #f5a623`, `--accent-bright #ffc65a`, `--accent-dim rgba(245,166,35,.55)`, `--accent-plate #f5a623` |
| Hairlines | amber-tinted: `--line .16`, `--line-strong .34`, `--line-faint .08` |
| Text | `--text #f2ead9` (warm off-white), `--text-dim #b39b78`, `--text-faint #7d6c53` |
| Destructive / fault | `--bad #ff6b57` — reserved for the failed-run crossed ring, the request-changes action, and P1 priority. It is the *only* second hue, and it never marks routine state. |

Color strategy: **Restrained** — one saturated amber carrying the surface on near-black, warm-neutral text. No second accent for state.

## Type

- **JetBrains Mono** (bundled `@font-face`, weights 500/700) carries all data: lane numbers (`01`..`NN`, zero-padded, tabular), ticket ids, counts, chips, costs, timestamps, config keys.
- **Condensed grotesque** (`--cond`: Arial Narrow / Roboto Condensed → system) sets the brand wordmark, panel titles, and small-cap legend heads — uppercase, tight tracking.
- Body prose: system sans, warm-neutral.

## Signature — the lane + link rail

Each row (`.lane`) is: `NN` · id · label · **`.lane-rail`** (a flex amber hairline ending in a `.lane-ring` ○) · meta · state chip · action. State is drawn on the rail by stroke, per the jackfield rule *no colour carries state*:

| Run state | Rail |
| --- | --- |
| running | solid line, filled ring (`--live`) |
| queued | dotted line, hollow dim ring (`--queued`) |
| stopped | dashed line broken by a `//` gap (`--gap`) |
| succeeded / selected | doubled line (`--double`) |
| failed | dashed line, open **crossed** ring in `--bad` (`--ring`) |

Chips are amber small-caps (outline, or knocked-dark-out-of-an-amber-plate for `chip-done`); they label, the rail signals.

## Layout

`.deck` = `296px` sticky **legend** + fluid **console**, inside a `1680px` bordered slab (edge gutters). Legend: brand + `BR` plate, FLEET STATUS stats, SCOPE (repo select + auto-claim), THROUGHPUT·7D sparkline, and the load-bearing merge-gate operator note pinned to the bottom. Console: topbar (`● scope · MODE LIVE · stats`), New run, `lanes-grid` (Backlog queue | Agents running), Recent runs, Review a PR, `console-strip` (Recently shipped | Activity feed), Config. The run **drawer** is a fixed right panel (log + PR panel).

Rank by **inversion**: the amber `BR` mark and `chip-done` knock dark out of a solid amber plate; lanes tint amber on hover.

## Responsive & motion

- `<1080px` the two-column grids stack; `<840px` the legend collapses above the console (row-wrap), keeping the edge gutters.
- Lane titles truncate (`min-width:0` + ellipsis) so a long ticket title never overflows; the rail always keeps ≥48px.
- Motion is restrained to one live signal: the `.pulse-dot` by MODE LIVE. Rails and type are static (an ops board at rest until something needs you).

## Invariants the design must keep

- The merge-gate operator note is content, not decoration — the agent never merges and there is **no merge control** in the UI.
- Every behavior selector (`.launch-btn`, `.agent-row`, `.agent-stop`, `.repo-select`, `.auto-claim-toggle`, `.newrun-*`, `.config-*`, `.pr-*`, `.recent-run`, `.run-drawer-*`) is preserved; the redesign is visual only.
- State is legible without colour (rail pattern), so the board stays readable for colour-blind operators and in a dim room.
