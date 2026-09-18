---
name: Helmsman
description: A navigation bridge for supervising a fleet of autonomous coding agents.
colors:
  instrument-ground: "#08090c"
  gutter: "#050506"
  rack-rail: "#101216"
  faceplate: "#16181e"
  faceplate-raised: "#1b1e25"
  faceplate-bevel: "#23262f"
  signal-amber: "#f5a623"
  signal-amber-bright: "#ffc65a"
  signal-amber-dim: "rgba(245, 166, 35, 0.5)"
  silkscreen: "#eee6d6"
  silkscreen-dim: "#b7a488"
  silkscreen-faint: "#94856d"
  fault-red: "#ff6b57"
  succeeded-green: "#46e2a0"
  review-blue: "#58c7ff"
  queued-amber: "#ffb02e"
  live-green: "#57e39a"
  scope-ground: "#05100b"
  phosphor-green: "#4df2a1"
  phosphor-bright: "#daffee"
  lamp-idle: "#2a2d34"
  hairline: "rgba(245, 166, 35, 0.15)"
  hairline-strong: "rgba(245, 166, 35, 0.32)"
  hairline-faint: "rgba(255, 255, 255, 0.06)"
typography:
  display:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  label:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.14em"
  label-fine:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.16em"
  label-micro:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "9px"
    fontWeight: 700
    letterSpacing: "0.2em"
  data:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 500
    fontFeature: "tabular-nums"
  data-lg:
    fontFamily: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    fontSize: "13px"
    fontWeight: 500
    fontFeature: "tabular-nums"
  numeric:
    fontFamily: '"DSEG7", "JetBrains Mono", ui-monospace, monospace'
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "0.02em"
  numeric-sm:
    fontFamily: '"DSEG7", "JetBrains Mono", ui-monospace, monospace'
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "0.02em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.signal-amber}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  button-primary-hover:
    backgroundColor: "{colors.signal-amber}"
    textColor: "#0a0805"
  faceplate:
    backgroundColor: "{colors.faceplate}"
    textColor: "{colors.silkscreen}"
    rounded: "{rounded.sm}"
  faceplate-title:
    textColor: "{colors.silkscreen}"
    typography: "{typography.label}"
  chip-outline:
    backgroundColor: "transparent"
    textColor: "{colors.signal-amber}"
    typography: "{typography.label}"
    padding: "2px 7px"
  chip-done:
    backgroundColor: "{colors.succeeded-green}"
    textColor: "#05130c"
    padding: "2px 7px"
  input:
    backgroundColor: "{colors.faceplate-raised}"
    textColor: "{colors.silkscreen}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "6px 9px"
  tuning-select:
    backgroundColor: "{colors.faceplate-raised}"
    textColor: "{colors.silkscreen}"
    rounded: "{rounded.sm}"
    padding: "6px 9px"
  page-tab:
    backgroundColor: "{colors.rack-rail}"
    textColor: "{colors.silkscreen-faint}"
    typography: "{typography.label}"
    padding: "7px 14px"
  page-tab-active:
    backgroundColor: "{colors.faceplate}"
    textColor: "{colors.signal-amber}"
  nameplate-mark:
    backgroundColor: "{colors.rack-rail}"
    textColor: "{colors.signal-amber}"
    rounded: "50%"
    size: "52px"
---

# Design System: Helmsman

## Overview

**Creative North Star: "The Navigation Bridge"**

Helmsman is a ship's navigation bridge for an autonomous coding fleet. The **Helm** page puts launch controls, fleet state, review decisions, and the **Ship’s log** within reach. Brushed-graphite faceplates sit on dark mounting rails; the operator can drag panels to reorder, stack them into tabs, and collapse them. The arrangement persists across sessions.

The bridge keeps a near-black ground, brushed metal, and one signal amber for legends, hairlines, and highlights. Phosphor-green run logs and amber seven-segment fleet counts remain readable in the dark. State is told by **shape** first: filled, hollow, and crossed indicator lamps plus distinct lane-rail strokes carry meaning alongside color. The nameplate pairs the ship’s-wheel emblem with **Helmsman**, without a subtitle.

The startup sequence establishes the nautical identity: a ship's wheel sits inside a compass bearing ring while a route trace plots a course. Navigation, heading, course, crew, and fleet-readiness messages accompany loading. Once the dashboard is ready, motion settles to the LIVE lamp and brief control feedback so the operator can focus on the fleet.

**Key Characteristics:**
- Near-black instrument ground; brushed-graphite faceplates on black rack rails.
- One themeable signal amber; all other hues are fixed instrument signals.
- Two self-hosted voices only: JetBrains Mono (silkscreen labels + data) and DSEG7 (seven-segment numerics).
- Shape, not hue, carries state — LED lamp silhouette and lane-rail stroke pattern.
- Dockable rack: drag to reorder, stack into tabs, collapse; layout persists.
- No merge switch anywhere on the helm.

## Colors

A near-monochrome instrument palette: graphite grounds, one saturated signal amber, and a small set of fixed emissive signal colors that never bend to theming.

### Primary
- **Signal Amber** (`#f5a623`): the one accent and the only themeable hue. It carries every hairline, active tab underline, chip outline, faceplate count, button text, brand plate, focus ring, and the sparkline. **Signal Amber Bright** (`#ffc65a`) is the hover/link-hot step; **Signal Amber Dim** (`rgba(245,166,35,0.5)`) is drop-target and disabled-accent tint.

### Neutral (instrument ground + brushed metal)
- **Instrument Ground** (`#08090c`): the helm substrate behind faceplates. **Gutter** (`#050506`) is the page edge behind the bordered helm slab.
- **Rack Rail** (`#101216`): the black rail behind panels; the rest state of tabs and lamp bodies.
- **Faceplate** (`#16181e`), **Faceplate Raised** (`#1b1e25`), **Faceplate Bevel** (`#23262f`): the three graphite steps that build a milled panel — body, input/raised surface, and top-bevel highlight.
- **Silkscreen** (`#eee6d6` warm off-white), **Silkscreen Dim** (`#b7a488`), **Silkscreen Faint** (`#94856d`): screened label text, dimmed data, and faint legends — warm to read as printed ink on metal.
- **Hairlines**: amber-tinted `hairline` (`rgba(245,166,35,0.15)`), `hairline-strong` (`0.32`), and white-tinted `hairline-faint` (`rgba(255,255,255,0.06)`) for interior panel divisions.

### Fixed Instrument Signals (not expressive, not fully themed)
- **Phosphor Green** (`#4df2a1`) on **Scope Ground** (`#05100b`): reserved for the navigation run-log drawer only — graticule grid, glowing text, CRT shadow. Never a UI accent.
- **Live Green** (`#57e39a`): the LIVE lamp and the running lane-ring. Fixed across every theme.
- **Succeeded Green** (`#46e2a0`), **Review Blue** (`#58c7ff`), **Queued Amber** (`#ffb02e`), **Fault Red** (`#ff6b57`): state signals for chips and lane rails. Fault Red is reserved for the failed-run crossed ring, the request-changes action, the fault lamp, and P1 priority — it never marks routine state.

### Named Rules
**The Signal-Amber-Only Rule.** Exactly one accent carries the interface; all other hues are fixed instrument signals attached to a specific state, never used expressively or decoratively.

**The Dark-Ground Rule.** The `.helm` scope re-asserts the near-black ground, graphite faceplates, and warm text on top of any theme. A theme recolors the signal amber (and the state hues) — it can never wash the helm toward light. Auditing test: switch to GitHub Light; the faceplates and their text must stay dark and legible.

**The Phosphor Reserve Rule.** Phosphor green and the scope ground belong to the navigation log drawer alone. The only other emissive green on the helm is the fixed LIVE lamp / running lane-ring.

## Typography

**Display / Data / Label Font:** JetBrains Mono (self-hosted `@font-face`, weights 500 and 700).
**Numeric Font:** DSEG7 (self-hosted `@font-face`, weight 700) — a seven-segment LCD face.
**Body Font:** system sans (`ui-sans-serif, system-ui, …`) for free prose only (textareas, long operator copy).

**Character:** A single mono voice does nearly everything, printed as silkscreen small-caps on metal for labels and set tabular for data. The seven-segment face is the instrument's numeric readout — it appears only where a real helm display would glow. There is no condensed or system display face.

### Hierarchy
- **Display / Brand** (JetBrains Mono 700, 18px, letter-spacing 0.1em): the uppercase "Helmsman" wordmark. A 52px circular ship’s-wheel medallion with a compass needle anchors the header.
- **Label / Silkscreen** (JetBrains Mono 700, ~11px, letter-spacing 0.10–0.22em, UPPERCASE): faceplate titles, page tabs, slot tabs, lamp captions, throughput label. Screened caps with wide tracking are the helm's default label voice.
- **Data** (JetBrains Mono 500, 12–13px, tabular-nums): lane numbers (`01`..`NN`, zero-padded), ticket ids, repo names, costs, timestamps, config keys, PR badges.
- **Numeric / Seven-Segment** (DSEG7 700, 15–17px, letter-spacing 0.02em): the fleet readout digits (run / queue / review) and faceplate counts — amber, glowing where an instrument would.
- **Body** (system sans, 14px, line-height 1.5): free-form prose inside textareas only.

### Named Rules
**The Two-Voice Rule.** JetBrains Mono for all labels and data; DSEG7 for seven-segment numerics; system sans only inside free-text fields. No fourth face, and no condensed or system display type.

**The Silkscreen Rule.** Panel, tab, and lamp labels are uppercase JetBrains Mono with wide letter-spacing — printed legend ink, not sentence text.

## Layout

The helm is a bordered, centered slab (`max-width: 1720px`) with faint side rails, floated over the darker page gutter — nothing spans full width. A persistent viewport shell stacks vertically: **helm nameplate header** → **page tabs** → **scrolling page content** → **shared footer**. Header, repository selector, fleet counts, notifications, tabs, and footer retain their DOM identity across all seven views; only the content below the tabs changes. The Helm content contains the optional degraded banner, two-bay rack, and run drawer. The shared footer carries the merge-gate operator note and app metadata. Queue and review counts use the last Jira snapshot for the selected repository, or an em dash when unavailable, without extra external reads for the header.

The **rack** (`.helm-rack`) is a two-column grid (`1fr 1fr`, 16px gutter) of columns; each column is a vertical stack of faceplates with a drop-endstop at the bottom. The layout is driven by a pure engine (`src/logic/rack.ts`): columns → slots → tab-stacked panels. Panels can be dragged to reorder, dragged onto each other to stack into a tabbed slot, collapsed to their headers, and the whole arrangement is serialized to `localStorage` (`helmsman.rackLayout`) so the operator's helm persists. Default layout: New voyage / Backlog queue / Active crew / Open PRs in the left bay; Recent voyages / Ship’s log / Out to sea in the right. Open PRs includes all authors in the selected repository; without a repository selection, the panel prompts the operator to choose one. Saved layouts migrate the former My open PRs panel in place, preserving stacks and collapse state.

The PR tab places **Review requests** and **My open PRs** in two adjacent graphite panels above the lookup and review controls, stacking them on narrow screens. Rows show the full repository, PR number, title, draft status, and review decision when available. Each list has its own loading, unavailable, empty, and partial-result state. Selecting a row opens the existing review controls; keyboard users can activate rows with Enter or Space.

Other pages reuse the same helm shell. Panels fill the content width or sit in two equal columns. **Triage** pairs the two unassigned groups above a full-width Mine · underway panel; **Below Decks** pairs the tab list and screen detail in equal columns. Config and Voyages panels fill the content width. Config shows the selected theme's surface, text, and status swatches plus sample status chips; previews use the theme variables and update immediately.

Spacing rhythm is tight and utilitarian: 14–16px between panels and around helm padding, 8px within control clusters, 4px micro-gaps in lamps and tallies. Helm padding is `16px 22px 30px`.

Responsive: below **1080px** the rack and triage grids collapse to a single column; below **1100px** the centered fleet readout wraps beneath the nameplate; below **840px** form field grids stack and tabs scroll horizontally. The header and footer remain outside the content scroll area. Auto-claim has no header control; theme selection lives in Config’s UI customization panel. Lane titles truncate (`min-width:0` + ellipsis) so a long ticket title never overflows; the lane rail always keeps ≥48px.

## Elevation & Depth

Depth is **material, not ambient** — every surface is built to read as a physical rack-mounted metal panel, not as a floating card. The faceplate combines three cues at once: a top-bevel highlight (`inset 0 1px 0 rgba(255,255,255,0.08)`), an inset dark seating ring (`inset 0 0 0 1px rgba(0,0,0,0.35)`), and a real drop shadow (`0 3px 10px rgba(0,0,0,0.35)`), over a brushed-metal gradient (a 1px repeating vertical striping plus a top-lit graphite gradient). The helm header and run drawer carry the same inset-highlight + drop-shadow pair.

Glow is treated as **light emission, never elevation**: LED lamps cast a colored `box-shadow` halo (e.g. `0 0 7px var(--live-green)`), the phosphor scope text carries a green `text-shadow`, and the brand plate uses inset shadows to look domed and pressed.

### Shadow Vocabulary
- **Machined faceplate** (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(0,0,0,0.35), 0 3px 10px rgba(0,0,0,0.35)`): every rack unit and the run drawer.
- **Header/helm strip** (`inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.4)`): the nameplate header.
- **Helm medallion**: a dark radial metal ground, inset highlight, and amber wheel rim; the central compass needle carries a small light-facing edge.
- **LED halo** (`0 0 5–7px <signal>`): live and queued lamps; a light, not a lift.
- **Phosphor bloom** (`text-shadow: 0 0 4px rgba(77,242,161,0.3)`): navigation log text.

### Named Rules
**The Machined-Faceplate Rule.** Every rack unit carries the top-bevel highlight + inset dark ring + drop shadow so it reads as a seated metal panel. Colored shadow is reserved for light-emitting elements (lamps, phosphor); it is never used to lift a surface.

## Shapes

One small radius everywhere: **3px** (`--radius`), applied to faceplates, the header, buttons, chips, inputs, and the brand plate. The helm is milled, not rounded — corners are crisp and hardware-like, never soft. Divisions are drawn with 1px hairlines (amber-tinted between structural regions, white-tinted for interior rows). Recurring hardware silhouettes give the world its form: 5px screw-head dots at the top corners of each faceplate; small circular LED lamps; the round `.lane-ring` terminating each lane rail; and nautical wheel and compass details in the nameplate.

### Named Rules
**The 3px Rule.** All corners use the single 3px radius. Do not introduce a second radius; the helm is machined metal, not a soft card UI.

## Components

### Buttons
- **Shape:** crisp 3px corners (`--radius`); uppercase JetBrains Mono, letter-spacing 0.08em.
- **Default (momentary push-button):** transparent fill, amber text, `hairline-strong` border, padding `5px 12px`.
- **Hover:** fills solid signal amber with near-black text (`#0a0805`) — the button "lights". Transition is fast (`background/color 90ms`).
- **Request-changes:** hover fills Fault Red instead of amber — the one destructive push-button.
- **Focus:** 2px solid amber outline, 1px offset.

### Chips
- **Style:** small uppercase mono, outline in `hairline-strong`, amber text; padding `2px 7px`. Chips **label**; the lane rail carries state.
- **Variants:** `chip-done` knocks dark text out of a solid Succeeded-Green plate; `chip-review` (blue), `chip-blocked` (Fault Red), `chip-progress` (amber), `chip-queued` (dim). Priority chips (`pri-p1`/`p2`/`p3`) are tighter outline chips; P1 is Fault Red.

### Faceplate (signature — the rack unit)
- **Corner Style:** 3px.
- **Background:** brushed-graphite — a 1px repeating vertical striping over a top-lit `faceplate-bevel → faceplate` gradient.
- **Header (34px):** a drag grip (grabbable), silkscreen title *or* a slot-tab strip when panels are stacked, a state lamp pushed to the right, an optional seven-segment count, and a collapse toggle. Screw-head dots sit at both top corners.
- **States:** `is-dragging` (opacity 0.45), `is-drop-target` (amber-dim outline), `is-collapsed` (body hidden, header only).
- **Elevation:** the Machined-Faceplate shadow.

### Indicator Lamps (signature — shape carries state)
LED caption + a 9px lamp dot whose **silhouette** is the tell, so hue is never the sole signal:
- **Live:** filled green dot with a green halo (pulses on the header LIVE lamp).
- **Queued:** hollow amber **ring**.
- **Idle:** flat dark grey dot, no glow.
- **Fault:** filled red dot clipped to a **crossed/asterisk** silhouette.

Note: panel faceplate lamps light only **live / queued / idle**. Run **fault** is carried by the lane-rail crossed-ring (⊗), not by a panel lamp — `.lamp-fault` exists in the vocabulary but is not lit on rack panels.

### Lane + Link Rail (signature — run state by stroke)
Each row (`.lane`) is `NN` · id · label · **`.lane-rail`** (a flex amber hairline ending in a `.lane-ring` ○) · meta · chip · action. State is drawn on the rail by **stroke pattern**, never by hue alone:

| Run state | Rail |
| --- | --- |
| running / live | solid line, filled ring (Live Green) |
| queued | dotted line, hollow ring (Queued Amber) |
| succeeded / selected | doubled line, filled ring (Succeeded Green) |
| stopped | dashed line broken by a `//` gap |
| failed / fault | dashed line, open **crossed** ring (Fault Red) |

### Inputs / Fields
- **Style:** raised-surface fill (`faceplate-raised`), 1px `hairline` border, 3px corners, mono 12px.
- **Focus:** border shifts to solid amber; `:focus-visible` adds a 2px amber outline.

### Tuning Controls (run preparation)
- **Purpose:** the paired **Model + Effort** selects that configure a run before launch. They sit in the New-run faceplate (after the repo select) and in the PR review/re-run controls, grouped like paired controls on a navigation console.
- **Style:** a `.tuning` flex row of two equal-width `.tuning-select` dropdowns (`flex: 1 1 0`), each an input-styled select — raised-surface fill (`faceplate-raised`), 1px `hairline` border, 3px corners — set in mono at a slightly finer 11px with normal casing (values are shown as written, not silkscreened).
- **Focus:** same as inputs — border shifts to solid amber, `:focus-visible` adds a 2px amber outline.

### Navigation (page tabs)
- **Primary page:** **Helm**, with the working fleet panels and Ship’s log.
- **Style:** uppercase mono on rack-rail ground, 2px transparent bottom-border; hover lifts the text to dim.
- **Active:** amber text on faceplate ground with a 2px amber bottom-border. Slot tabs (within a stacked faceplate) use the same pattern at a smaller size.

### Navigation Run Drawer (signature)
The live run log is a navigation-console display: phosphor-green mono text on scope ground, over a graticule built from two crossed repeating-linear-gradients (22px rows × 26px columns), with a green text-shadow bloom. Tabs across the top let the operator keep several runs open; a small dot marks a completed run. Tool lines are dimmer green, errors go Fault Red (no bloom), results brighten toward white.

### Startup / Course Plotting
The shared wheel-and-compass emblem (`public/helm-emblem.svg`) appears in both the header and loading screen. A compass bearing ring surrounds it during loading; there is no separate letter badge. A route trace supplies the course-plotting motion; the Helmsman wordmark, progress readout, and navigation log preserve the graphite-and-amber bridge styling. Loading messages refer to navigation, heading, course, crew, and fleet readiness. The sequence yields to the Helm dashboard when loading completes; reduced-motion preferences suppress continuous animation.

### Seven-Segment Readout
The header fleet readout renders run / queue / review counts in DSEG7 amber digits beside silkscreen captions; faceplate counts reuse the same seven-segment face. This is the helm's only numeric display voice.

## Do's and Don'ts

### Do:
- **Do** carry every hairline, tab underline, count, and highlight in the single signal amber (`#f5a623`); let the theme recolor only the accent.
- **Do** encode state by shape first — lane-rail stroke pattern and LED lamp silhouette — so the helm is legible without color.
- **Do** build every panel as a machined faceplate: brushed gradient, top-bevel highlight, inset dark ring, drop shadow, 3px corners, screw-head dots.
- **Do** set all labels in uppercase JetBrains Mono with wide tracking, and all counts in DSEG7 seven-segment.
- **Do** keep the merge-gate operator note as screened helm content; it is load-bearing product truth, not decoration.
- **Do** preserve the dockable-rack behavior (drag / stack / collapse / persist) and every behavior selector (`.launch-btn`, `.agent-row`, `.agent-stop`, `.repo-select`, `.auto-claim-toggle`, `.newrun-*`, `.config-*`, `.pr-*`, `.recent-run`, `.rack-handle`, `.panel-collapse`, `.run-*`).

### Don't:
- **Don't** add a second expressive accent, or use a state hue (green/red/blue) for anything but its assigned instrument signal. Fault Red never marks routine state.
- **Don't** let phosphor green or the scope ground leave the navigation drawer.
- **Don't** introduce a merge control anywhere on the helm — the agent never merges; merge is a human action on GitHub. (Hard product invariant.)
- **Don't** ship a light-washed surface: `.helm` must re-assert the dark ground under every theme.
- **Don't** add a second corner radius or a condensed/system display face; one radius (3px) and two self-hosted voices only.
- **Don't** blank a slice on missing data — degrade to sample data behind the banner, keeping the panel rendered.
