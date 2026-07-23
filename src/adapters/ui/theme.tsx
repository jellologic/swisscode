// The terminal's half of the design system.
//
// The browser UI names a ROLE and lets Panda resolve it — `accent.default`,
// `ok.default`, `content.tertiary` — and `strictTokens` makes writing a raw
// colour there a compile error. Ink has no such machinery: a component takes
// `color="cyan"` and that is the whole story, which is how this wizard came to
// hold nine unrelated cyans, five reds and a green, none of which agreed on
// what they were for. This module is the half that was missing. What the two
// surfaces share is the VOCABULARY, not the values: `danger` means the same
// thing on both, and renders as #cf222e in a browser and as ANSI red here.
//
//   role        here                web/panda.config.ts + web/src/ui.tsx
//   ─────────── ─────────────────── ────────────────────────────────────
//   (default)   no props at all     content.primary
//   muted       dimColor            content.tertiary   (Tone 'neutral')
//   heading     bold                fontWeight 'title' / textStyle 'heading'
//   accent      cyan                accent.default     (Tone 'accent')
//   selected    cyan + bold         surface.panel + content.primary
//   ok          green + bold        ok.default         (Tone 'ok')
//   warn        yellow + bold       warn.default       (Tone 'warn')
//   danger      red + bold          danger.default     (Tone 'danger')
//
// THERE IS NO ROLE FOR ORDINARY TEXT, deliberately. A terminal's default
// foreground already IS `content.primary` — the user chose it, along with the
// background it has to sit on. The way a TUI ends up unreadable on a light
// terminal is by deciding on the user's behalf that body text is `white`.
//
// NAMED ANSI COLOURS, NEVER HEX. Ink accepts `#5e6ad2` and chalk will
// down-convert it, but it converts against whatever depth the terminal reports,
// and a 16-colour terminal gets the nearest of eight — a lottery this file
// would rather not enter. Naming the colour instead hands the exact shade to
// the user's theme, which is the terminal's version of honouring
// `prefers-color-scheme`. It is also why the accent is cyan rather than the
// web's indigo: there is no indigo in sixteen colours, and cyan is the one of
// the eight that no status role here wants.
//
// EVERY ROLE CARRIES A SECOND CHANNEL. Colour is the least dependable thing a
// terminal has: it is absent under NO_COLOR and through a pipe, it is remapped
// wholesale by every popular theme, and red/green is the most common colour
// deficiency there is. So no role below is told apart by hue alone — each pairs
// its colour with `bold` or `dimColor`, and the screens add a glyph (`›`, `✓`,
// `?`, `·`, `★`) wherever a status is being reported rather than merely
// emphasised. Strip the colour out of the wizard and it still reads.
import React from 'react'
import { Box, Text } from 'ink'
import SelectInput from 'ink-select-input'
import type { TextProps } from 'ink'
import type { IndicatorProps, ItemProps } from 'ink-select-input'

/**
 * The subset of `<Text>` a role is allowed to set.
 *
 * Narrow on purpose. `italic`, `underline` and `strikethrough` are rendered by
 * some emulators and silently dropped by others, so a role built on one would
 * be invisible exactly where its second channel is needed most.
 * `backgroundColor` is worse than unreliable — see `selected`.
 */
type ToneProps = Pick<TextProps, 'color' | 'bold' | 'dimColor'>

/**
 * The one accent hue, spelled once.
 *
 * Two roles use it and the difference between them is emphasis, not meaning,
 * which is the sort of thing that stops being true the moment the string is
 * written twice.
 */
const ACCENT = 'cyan'

export const tone = {
  /**
   * Labels, hints, footers, stated absences — everything the eye should skip on
   * its way to the answer. The web's `content.tertiary`.
   */
  muted: { dimColor: true },

  /**
   * The subject of a screen: the model you are inspecting, the profile you are
   * acting on, the wordmark. WEIGHT, NOT HUE, because that is what the web does
   * — a heading there is `fontWeight: 'title'` over the ordinary text colour —
   * and because spending the accent on text that cannot be interacted with is
   * what stops `›` and the cursor row from meaning anything.
   */
  heading: { bold: true },

  /**
   * An affordance: the `›` you type after, the `▌` marking the live cursor, the
   * filled part of a meter. Reserved for things that are interactive or are
   * tracking the interaction.
   */
  accent: { color: ACCENT },

  /**
   * The row the cursor is on.
   *
   * The web slides a `surface.panel` background under its selected row. A
   * terminal must not: the background belongs to the user's colour scheme, and
   * painting one is how a UI ends up with unreadable text under a theme its
   * author never ran. Hue and weight do that work here, and every list using
   * this also dims its other rows and prefixes the active one with `›`, so the
   * selection survives with no colour at all.
   */
  selected: { color: ACCENT, bold: true },

  /** Something the user asked for happened. */
  ok: { color: 'green', bold: true },

  /**
   * Proceed, but know this: a binding the core refused, a capability the
   * catalog declines to publish. Distinct from `muted`, which says "not
   * important" — an unknown is important precisely because it is unknown, and
   * rendering the two the same is how a caveat gets read as decoration.
   */
  warn: { color: 'yellow', bold: true },

  /** It failed, or it is going to. */
  danger: { color: 'red', bold: true },
} satisfies Record<string, ToneProps>

/**
 * The wizard's frame, which `<Box borderColor>` takes as a bare colour rather
 * than as `<Text>` props.
 *
 * The accent, not the recessive hairline the web draws around a panel. A
 * browser separates a panel from the page with a background it paints; this
 * border is the only thing dividing the wizard from the scrollback above it, so
 * it does the job `surface.panel` does there. It is also the surface that
 * currently holds focus, and an accent-coloured edge on the focused thing is
 * what the web draws too (`_focus: { borderColor: 'accent.default' }`).
 */
export const frameBorder = ACCENT

/**
 * `ink-select-input` renders every menu in the wizard, and it hardcodes `blue`
 * for both the pointer and the highlighted label.
 *
 * That is one meaning — "this is the row you are on" — wearing a second colour,
 * on the most-looked-at pixel of the first screen a new user ever sees, right
 * next to hand-rolled lists that spell the same idea in `selected`. The library
 * anticipates this and takes `indicatorComponent` / `itemComponent`, so the
 * menus join the table rather than sitting outside it.
 *
 * Unselected rows get NO props, not `muted`. Every row here is a live choice;
 * dimming the ones the cursor happens to be off would file the user's options
 * with the footnotes. The hand-rolled lists dim their inactive rows because
 * those are reference data — the tier you are not editing, the model you are
 * not on — and that difference is the reason there is no single "list row"
 * role.
 */
function ThemedIndicator({ isSelected = false }: IndicatorProps) {
  return (
    <Box marginRight={1}>
      {/* The library reaches for `figures.pointer`, which degrades to `>` on a
          console with no Unicode. `figures` is its dependency and not ours, and
          adding one to a project that advertises four is not a trade worth
          making for a fallback the wizard already forfeited everywhere else —
          `›`, `★`, `✓`, `▌` and `█` all ship unguarded. Same glyph, one hue
          moved. */}
      {isSelected ? <Text {...tone.accent}>❯</Text> : <Text> </Text>}
    </Box>
  )
}

function ThemedItem({ isSelected = false, label }: ItemProps) {
  return <Text {...(isSelected ? tone.selected : {})}>{label}</Text>
}

/**
 * A `SelectInput` that knows the palette. Every menu in the wizard goes through
 * here.
 *
 * The props type is read off the library's own component rather than restated,
 * so this stays a pass-through: a wrapper that redeclared the interface would
 * be inventing a contract, and would drift the first time the library added an
 * option. `typeof SelectInput<V>` instantiates the generic, so `onSelect` still
 * hands back the caller's own value type — which is what keeps the models step
 * able to test `item.value === '__done'` and narrow the rest to a `Tier`
 * without an assertion.
 */
export function Select<V>(props: Parameters<typeof SelectInput<V>>[0]) {
  return <SelectInput {...props} indicatorComponent={ThemedIndicator} itemComponent={ThemedItem} />
}
