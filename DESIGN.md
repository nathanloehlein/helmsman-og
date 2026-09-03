---
name: GoMaestro
description: A benchtop instrument rack for supervising autonomous coding agents.
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
  page-tab:
    backgroundColor: "{colors.rack-rail}"
    textColor: "{colors.silkscreen-faint}"
    typography: "{typography.label}"
    padding: "7px 14px"
  page-tab-active:
    backgroundColor: "{colors.faceplate}"
    textColor: "{colors.signal-amber}"
  nameplate-mark:
    backgroundColor: "{colors.signal-amber}"
    textColor: "#0a0805"
    typography: "{typography.display}"
    rounded: "{rounded.sm}"
    size: "30px"
---

# Design System: GoMaestro

## Overview

**Creative North Star: "The Instrument Bench"**

GoMaestro is a bench of rack-mounted test instruments. Each panel is a rack unit — a brushed-graphite faceplate seated on black rack rails — that the operator drags to reorder, stacks into a tabbed drawer, and powers down (collapse); the arrangement persists across sessions. The operator arranges their bench, reads fleet state at a glance across lit faceplates, and launches, stops, and reviews runs from momentary push-buttons. It is a workbench, not a mission-control HUD, and it refuses the glowing tactical dashboard as firmly as it refuses the prior patch-bay jackfield it replaced.

The world is dark-committed and near-monochrome by intent: a near-black instrument ground carries brushed-metal faceplates, and a single signal amber does the work of legend, hairline, and highlight. Two emissive materials break the graphite — a phosphor-green oscilloscope screen that carries the live run log, and amber seven-segment numerics for the fleet readout and faceplate counts. Instrument state is told by **shape** first: LED indicator lamps whose silhouette (filled dot / hollow ring / crossed) carries meaning, and lane rails whose stroke pattern carries run state, so hue is never the sole signal. The result reads as calibrated lab hardware: legible in a dim room, honest at a glance, expressive only where a real instrument would light up.

Density is high and utilitarian; nothing is decorative for its own sake except the knurled-knob and BNC-jack hardware screened into the nameplate. Motion is almost absent — one pulsing LIVE lamp, one fast button press — because a bench is at rest until something needs the operator.

**Key Characteristics:**
- Near-black instrument ground; brushed-graphite faceplates on black rack rails.
- One themeable signal amber; all other hues are fixed instrument signals.
- Two self-hosted voices only: JetBrains Mono (silkscreen labels + data) and DSEG7 (seven-segment numerics).
- Shape, not hue, carries state — LED lamp silhouette and lane-rail stroke pattern.
- Dockable rack: drag to reorder, stack into tabs, collapse; layout persists.
- No merge switch anywhere on the bench.

## Colors

A near-monochrome instrument palette: graphite grounds, one saturated signal amber, and a small set of fixed emissive signal colors that never bend to theming.

### Primary
- **Signal Amber** (`#f5a623`): the one accent and the only themeable hue. It carries every hairline, active tab underline, chip outline, faceplate count, button text, brand plate, focus ring, and the sparkline. **Signal Amber Bright** (`#ffc65a`) is the hover/link-hot step; **Signal Amber Dim** (`rgba(245,166,35,0.5)`) is drop-target and disabled-accent tint.

### Neutral (instrument ground + brushed metal)
- **Instrument Ground** (`#08090c`): the bench substrate behind faceplates. **Gutter** (`#050506`) is the page edge behind the bordered bench slab.
- **Rack Rail** (`#101216`): the black rail behind panels; the rest state of tabs and lamp bodies.
- **Faceplate** (`#16181e`), **Faceplate Raised** (`#1b1e25`), **Faceplate Bevel** (`#23262f`): the three graphite steps that build a milled panel — body, input/raised surface, and top-bevel highlight.
- **Silkscreen** (`#eee6d6` warm off-white), **Silkscreen Dim** (`#b7a488`), **Silkscreen Faint** (`#94856d`): screened label text, dimmed data, and faint legends — warm to read as printed ink on metal.
- **Hairlines**: amber-tinted `hairline` (`rgba(245,166,35,0.15)`), `hairline-strong` (`0.32`), and white-tinted `hairline-faint` (`rgba(255,255,255,0.06)`) for interior panel divisions.

### Fixed Instrument Signals (not expressive, not fully themed)
- **Phosphor Green** (`#4df2a1`) on **Scope Ground** (`#05100b`): reserved for the oscilloscope run-log drawer only — graticule grid, glowing text, CRT shadow. Never a UI accent.
- **Live Green** (`#57e39a`): the LIVE lamp and the running lane-ring. Fixed across every theme.
- **Succeeded Green** (`#46e2a0`), **Review Blue** (`#58c7ff`), **Queued Amber** (`#ffb02e`), **Fault Red** (`#ff6b57`): state signals for chips and lane rails. Fault Red is reserved for the failed-run crossed ring, the request-changes action, the fault lamp, and P1 priority — it never marks routine state.

### Named Rules
**The Signal-Amber-Only Rule.** Exactly one accent carries the interface; all other hues are fixed instrument signals attached to a specific state, never used expressively or decoratively.

**The Dark-Ground Rule.** The `.bench` scope re-asserts the near-black ground, graphite faceplates, and warm text on top of any theme. A theme recolors the signal amber (and the state hues) — it can never wash the bench toward light. Auditing test: switch to GitHub Light; the faceplates and their text must stay dark and legible.

**The Phosphor Reserve Rule.** Phosphor green and the scope ground belong to the oscilloscope log drawer alone. The only other emissive green on the bench is the fixed LIVE lamp / running lane-ring.

## Typography

**Display / Data / Label Font:** JetBrains Mono (self-hosted `@font-face`, weights 500 and 700).
**Numeric Font:** DSEG7 (self-hosted `@font-face`, weight 700) — a seven-segment LCD face.
**Body Font:** system sans (`ui-sans-serif, system-ui, …`) for free prose only (textareas, long operator copy).

**Character:** A single mono voice does nearly everything, printed as silkscreen small-caps on metal for labels and set tabular for data. The seven-segment face is the instrument's numeric readout — it appears only where a real bench display would glow. There is no condensed or system display face.

### Hierarchy
- **Display / Brand** (JetBrains Mono 700, 18px, letter-spacing -0.02em): the "GoMaestro" nameplate wordmark and the `GM` brand plate.
- **Label / Silkscreen** (JetBrains Mono 700, ~11px, letter-spacing 0.10–0.22em, UPPERCASE): faceplate titles, page tabs, slot tabs, lamp captions, model legend (`MDL·01 FLEET CONSOLE`), throughput label. Screened caps with wide tracking are the bench's default label voice.
- **Data** (JetBrains Mono 500, 12–13px, tabular-nums): lane numbers (`01`..`NN`, zero-padded), ticket ids, repo names, costs, timestamps, config keys, PR badges.
- **Numeric / Seven-Segment** (DSEG7 700, 15–17px, letter-spacing 0.02em): the fleet readout digits (run / queue / review) and faceplate counts — amber, glowing where an instrument would.
- **Body** (system sans, 14px, line-height 1.5): free-form prose inside textareas only.

### Named Rules
**The Two-Voice Rule.** JetBrains Mono for all labels and data; DSEG7 for seven-segment numerics; system sans only inside free-text fields. No fourth face, and no condensed or system display type.

**The Silkscreen Rule.** Panel, tab, and lamp labels are uppercase JetBrains Mono with wide letter-spacing — printed legend ink, not sentence text.

## Layout

The bench is a bordered, centered slab (`max-width: 1720px`) with faint side rails, floated over the darker page gutter — nothing spans full width. It stacks vertically: **bench nameplate header** → optional degraded banner → **two-bay rack** → oscilloscope run drawer → merge-gate operator note → footer.

The **rack** (`.bench-rack`) is a two-column grid (`1fr 1fr`, 16px gutter) of columns; each column is a vertical stack of faceplates with a drop-endstop at the bottom. The layout is driven by a pure engine (`src/logic/rack.ts`): columns → slots → tab-stacked panels. Panels can be dragged to reorder, dragged onto each other to stack into a tabbed slot, collapsed (powered down), and the whole arrangement is serialized to `localStorage` (`gomaestro.rackLayout`) so the operator's bench persists. Default layout: New run / Backlog / Agents-running in the left bay; Review-a-PR / Recent / Activity / Shipped / Config in the right.

Other pages reuse the same bench shell: **Triage** is a three-column grid of ticket groups; **cmux** is a 280px tab list beside a fluid screen detail.

Spacing rhythm is tight and utilitarian: 14–16px between panels and around bench padding, 8px within control clusters, 4px micro-gaps in lamps and tallies. Bench padding is `16px 22px 30px`.

Responsive: below **1080px** the rack and triage grids collapse to a single column; below **840px** the bench header wraps, the auto-claim/controls unstick, and form field grids stack. Lane titles truncate (`min-width:0` + ellipsis) so a long ticket title never overflows; the lane rail always keeps ≥48px.

## Elevation & Depth

Depth is **material, not ambient** — every surface is built to read as a physical rack-mounted metal panel, not as a floating card. The faceplate combines three cues at once: a top-bevel highlight (`inset 0 1px 0 rgba(255,255,255,0.08)`), an inset dark seating ring (`inset 0 0 0 1px rgba(0,0,0,0.35)`), and a real drop shadow (`0 3px 10px rgba(0,0,0,0.35)`), over a brushed-metal gradient (a 1px repeating vertical striping plus a top-lit graphite gradient). The bench header and run drawer carry the same inset-highlight + drop-shadow pair.

Glow is treated as **light emission, never elevation**: LED lamps cast a colored `box-shadow` halo (e.g. `0 0 7px var(--live-green)`), the phosphor scope text carries a green `text-shadow`, and the brand plate uses inset shadows to look domed and pressed.

### Shadow Vocabulary
- **Machined faceplate** (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(0,0,0,0.35), 0 3px 10px rgba(0,0,0,0.35)`): every rack unit and the run drawer.
- **Header/bench strip** (`inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.4)`): the nameplate header.
- **Pressed brand plate** (`inset 0 -2px 4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.4)`): the `GM` mark.
- **LED halo** (`0 0 5–7px <signal>`): live and queued lamps; a light, not a lift.
- **Phosphor bloom** (`text-shadow: 0 0 4px rgba(77,242,161,0.3)`): oscilloscope log text.

### Named Rules
**The Machined-Faceplate Rule.** Every rack unit carries the top-bevel highlight + inset dark ring + drop shadow so it reads as a seated metal panel. Colored shadow is reserved for light-emitting elements (lamps, phosphor); it is never used to lift a surface.

## Shapes

One small radius everywhere: **3px** (`--radius`), applied to faceplates, the header, buttons, chips, inputs, and the brand plate. The bench is milled, not rounded — corners are crisp and hardware-like, never soft. Divisions are drawn with 1px hairlines (amber-tinted between structural regions, white-tinted for interior rows). Recurring hardware silhouettes give the world its form: 5px screw-head dots at the top corners of each faceplate; small circular LED lamps; the round `.lane-ring` terminating each lane rail; and the knurled-knob and BNC-jack line icons screened into the nameplate.

### Named Rules
**The 3px Rule.** All corners use the single 3px radius. Do not introduce a second radius; the bench is machined metal, not a soft card UI.

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
- **States:** `is-dragging` (opacity 0.45), `is-drop-target` (amber-dim outline), `is-collapsed` (body hidden, header only — powered down).
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

### Navigation (page tabs)
- **Style:** uppercase mono on rack-rail ground, 2px transparent bottom-border; hover lifts the text to dim.
- **Active:** amber text on faceplate ground with a 2px amber bottom-border. Slot tabs (within a stacked faceplate) use the same pattern at a smaller size.

### Oscilloscope Run Drawer (signature)
The live run log is a CRT screen: phosphor-green mono text on scope ground, over a graticule built from two crossed repeating-linear-gradients (22px rows × 26px columns), with a green text-shadow bloom. Tabs across the top let the operator keep several runs open; a small dot marks a completed run. Tool lines are dimmer green, errors go Fault Red (no bloom), results brighten toward white.

### Seven-Segment Readout
The header fleet readout renders run / queue / review counts in DSEG7 amber digits beside silkscreen captions; faceplate counts reuse the same seven-segment face. This is the bench's only numeric display voice.

## Do's and Don'ts

### Do:
- **Do** carry every hairline, tab underline, count, and highlight in the single signal amber (`#f5a623`); let the theme recolor only the accent.
- **Do** encode state by shape first — lane-rail stroke pattern and LED lamp silhouette — so the bench is legible without color.
- **Do** build every panel as a machined faceplate: brushed gradient, top-bevel highlight, inset dark ring, drop shadow, 3px corners, screw-head dots.
- **Do** set all labels in uppercase JetBrains Mono with wide tracking, and all counts in DSEG7 seven-segment.
- **Do** keep the merge-gate operator note as screened bench content; it is load-bearing product truth, not decoration.
- **Do** preserve the dockable-rack behavior (drag / stack / collapse / persist) and every behavior selector (`.launch-btn`, `.agent-row`, `.agent-stop`, `.repo-select`, `.auto-claim-toggle`, `.newrun-*`, `.config-*`, `.pr-*`, `.recent-run`, `.rack-handle`, `.panel-collapse`, `.run-*`).

### Don't:
- **Don't** add a second expressive accent, or use a state hue (green/red/blue) for anything but its assigned instrument signal. Fault Red never marks routine state.
- **Don't** let phosphor green or the scope ground leave the oscilloscope drawer.
- **Don't** introduce a merge control anywhere on the bench — the agent never merges; merge is a human action on GitHub. (Hard product invariant.)
- **Don't** ship a light-washed surface: `.bench` must re-assert the dark ground under every theme.
- **Don't** add a second corner radius or a condensed/system display face; one radius (3px) and two self-hosted voices only.
- **Don't** blank a slice on missing data — degrade to sample data behind the banner, keeping the panel rendered.
