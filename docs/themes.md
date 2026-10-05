# Theme palettes

Themes use separate roles for page backgrounds, panels, controls, action accents, companion accents, and semantic states. Neutral borders separate components without tinting the whole interface with the action color. Companion accents identify section headings; action accents identify interactive elements. Status colors retain their existing meanings.

## References

- [Radix Colors: scale use cases](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) — separate page, component, border, and text roles.
- [Everforest palette](https://github.com/sainnhe/everforest/blob/master/palette.md) — restrained green-gray surfaces with gold, aqua, and warm accents; inspiration for Forest and Ember.
- [Rosé Pine palette](https://rosepinetheme.com/palette/ingredients/) — rose, foam, and iris accents on dark neutral surfaces; inspiration for Aubergine.
- [Nord colors and palettes](https://www.nordtheme.com/docs/colors-and-palettes) — distinct background, foreground, interaction, and semantic color families.

The named editor palettes are UI adaptations, not exact reproductions: small text and status colors are adjusted to remain readable on raised surfaces.

## Custom directions

| Theme | Surfaces | Action / companion |
| --- | --- | --- |
| Quarterdeck | Slate and blue-gray | Brass / mint |
| Abyss | Midnight indigo | Ice / rose |
| Forest | Sage charcoal | Gold / seafoam |
| Ember | Warm charcoal | Apricot / sage |
| Aubergine | Plum and ink | Rose / foam |
| Graphite | Neutral graphite | Apricot / powder blue |
| Phosphor | Smoked green-gray | Lime / lavender |
| Amber | Near-black graphite | Amber / ice |

Theme IDs remain stable so saved preferences still work. The loading screen and application share the same palette catalog. Amber uses the CSS root defaults; switching to it clears the other theme overrides.

Editable fields use a dedicated `--control-bg` surface and opaque `--control-border`, including fields inside raised PR panels and feature forms. Dark themes use recessed fills; light themes use shaded fills. Text and placeholders retain at least 4.5:1 contrast, and input boundaries retain at least 3:1 against both the fill and surrounding panel surfaces. Focus keeps the theme accent. The Input swatch in Appearance previews the field surface.

`src/data/themes.test.ts` checks text roles at 4.5:1 on the palette surfaces, filled-label contrast, control outlines at 3:1, and page/panel separation. These token checks complement browser checks; they do not certify every composite UI state.
