# Backlog Runner — Design

Committed visual world: **Tactical HUD** — a mission-control console for an autonomous agent. The old light theme (and the earlier auto-inverted `prefers-color-scheme` dark) are anti-reference, not authority.

## Use scene → dark

An ops monitor left open on a screen, glanced at from across a room, often in a dim room. Dark is chosen from that scene, not from category habit. Dark is the *only* committed world here — there is no light variant.

## Tokens

All defined on `:root` in `src/style.css` (`color-scheme: dark`).

| Role | Value |
| --- | --- |
| Void / page base | `#04060a` / `--bg #05070a` |
| Surfaces | `--surface #0c1016`, `--surface-2 #11161e`, `--surface-hi #151c26` (hover) |
| Hairlines | `--line rgba(120,160,178,.14)`, `--line-strong .26` |
| Text | `--text #eef4f8`, `--text-dim #9fb2bf`, `--text-faint #7f93a0` |
| Accent (live/agent) | `--accent #29e0c8`, `--accent-bright #5cf3df`, soft/line/glow variants |
| Status | done `--good #35e08a` · in-progress `--warn #f4b23e` · changes `--bad #ff6b6b` · in-review = accent cyan |

Secondary text is tinted cool (never flat gray) so it belongs to the surface. Contrast: body/dim text ≥ 4.5:1 on surfaces; faint is reserved for small mono meta and large labels.

## Type

- Body: system sans (`-apple-system, Segoe UI, …`).
- **JetBrains Mono** carries the identity: every id, timestamp, count, stat, chip label, and the brand wordmark. Mono is earned here — it renders code, data, and measurement, not "technical" costume. Tabular numerics via `font-variant-numeric`.
- Headline tracking `-0.01em`; balanced wrapping on the working-ticket headline.

## Depth

Layered surface gradient + hairline border + a **real drop shadow** (offset + blur) is the elevation system. The cyan glow is an **accent signal only** — the live pulse, the active step, the sparkline, the panel-title tick — never a substitute for a shadow.

HUD corner ticks: each panel draws a 9px cyan L at top-left and bottom-right via `::before`/`::after`. Panel titles carry a small glowing accent square.

## Motion

One authored moment: a single cyan **scan sweep** on boot (`body::after`, ~1.1s, exponential ease-out), plus the ambient **live pulse** on the status dot (the agent's heartbeat). Both are disabled under `prefers-reduced-motion`. No per-panel entrance animations.

## Icons

Authored inline SVGs at one consistent stroke — check (done step), filled dot (active step), lock (permission note). No emoji or HTML entities standing in for icons.

## Components

- **Chips** (status/priority): mono, uppercase, low-alpha tinted background + matching 1px border + colored text. In-review/accent chips carry a faint glow.
- **Status colors**: green = merged/done, amber = in progress, red = changes requested, cyan = in review / accent / live.
- **Sparkline**: cyan stroke with a `drop-shadow` glow; gradient area fill.
- **Empty states**: centered muted note per panel ("No backlog tickets assigned." / "No recent pull requests." / "No recent activity.").
- **Degraded banner**: amber-tinted, names which sources fell back to sample data.
- **Repo selector**: a HUD-styled `<select>` in the Recently Shipped head, listing "All repos" + every repo in `REPO_PROJECT_MAP` and the author's PRs. Choosing one **re-scopes the whole dashboard**: the client re-fetches `/api/dashboard?repo=…`, the server filters GitHub (shipped + PR activity) to that repo and re-queries Jira with the repo's mapped project (`REPO_PROJECT_MAP`), so the queue, working-on, stats, and throughput all follow the selection. The topbar label becomes the repo's short name. Custom cyan chevron, hover + `:focus-visible` glow ring for keyboard users. Selection is held by the client view controller (`DashboardView`) so it survives the 30s poll.

## Responsive

- Grid `300px · 1fr · 260px` → single column at `≤980px`.
- Topbar wraps at `≤600px`; the mini-stats reflow to a full-width row under a hairline so nothing clips. Body padding tightens to 16px.

## Full-viewport layout (≥981px)

The dashboard fills the whole window — width (no max-width cap; body padding is the gutter) and height (no page scroll). `body`/`#app`/`.wrap` chain to `100vh`; the grid takes the remaining height (`flex: 1; min-height: 0; align-items: stretch`) and long lists scroll inside their panels (backlog queue, working-on body, activity feed). Recently Shipped is a bottom band capped at `34vh` with its own internal scroll. Below 981px this all reverts to natural document flow so mobile scrolls normally.

## Intentional deviation

The faint two-axis **grid background** (`body::before`) is flagged `advisory` by the Impeccable detector as a generated-UI signature. It is kept deliberately: the committed Tactical HUD brief pins a grid/scanline field, and a pinned world overrides the detector. It is held at very low alpha (`--grid rgba(120,165,185,.045)`) so it never reduces text contrast — it reads as an ambient HUD field, not a decorative texture. Revisit if the world is ever re-briefed away from HUD.
