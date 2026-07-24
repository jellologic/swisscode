// The swisscode identity, in the UI.
//
// The logo, the two-tone "swiss·code" wordmark, and a small custom empty-state
// graphic, matched to assets/hero.svg and rebuilt as theme-aware React so the
// web UI reads as the same product. Colour comes from the `brand.*` tokens,
// which are reserved for identity and never used for controls (see the note in
// panda.config.ts).
//
// WHY THE MARK IS A PROMPT, NOT A CROSS. A white cross on red is the Swiss flag
// and coat of arms — restricted for commercial use, and evocative of the
// Victorinox "Swiss Army Knife" marks. So the mark keeps the RED HANDLE (a
// colour is not protectable) but drops the cross for a terminal chevron: it
// reads as a prompt (a coding tool), as two blades opening from a pivot (the
// multi-tool homage the name is really about — many providers from one
// launcher), and as none of the protected things. Do not "restore the cross":
// its absence is the point.
//
// The one hardcoded colour here is the white of the chevron and cursor. It is
// not a theme value that slipped past strictTokens — white-on-red is intrinsic
// to the mark and holds on either theme. strictTokens governs `css()` props,
// not SVG fill/stroke attributes, so it is stated plainly.
import type { ReactNode } from 'react'
import { css } from '../styled-system/css'

/**
 * The mark: a terminal prompt on a red tile.
 *
 * A chevron whose vertex is the pivot and whose two arms open like blades, plus
 * a block cursor — `❯█`. One bold chevron and one block, so it stays legible
 * from a 16px favicon to a 120px social card. The red tile is a fill behind
 * white, so it needs no light/dark variant.
 */
export function Logo({ size = 22, title = 'swisscode' }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
      className={css({ flexShrink: 0, display: 'block' })}
    >
      <rect width="100" height="100" rx="23" fill="var(--colors-brand-mark)" />
      {/* the prompt: a chevron (pivot at its point, arms as blades) + a block cursor */}
      <path
        d="M30 34 L54 50 L30 66"
        fill="none"
        stroke="#ffffff"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="62" y="41" width="13" height="18" rx="3" fill="#ffffff" />
    </svg>
  )
}

/**
 * "swiss" + "code" — the wordmark, with the coral half from the hero.
 *
 * A single element with two coloured spans rather than an image, so it inherits
 * the page's font and stays crisp at any zoom. `weight: title` (590) matches the
 * heading scale; the tracking comes from the textStyle.
 */
export function Wordmark({ style = 'heading' }: { style?: 'heading' | 'title' | 'display' }) {
  return (
    <span className={css({ textStyle: style, fontWeight: 'title', whiteSpace: 'nowrap' })}>
      <span className={css({ color: 'content.primary' })}>swiss</span>
      <span className={css({ color: 'brand.wordmark' })}>code</span>
    </span>
  )
}

/**
 * Logo + wordmark + one line of context, as the sidebar header.
 *
 * The subtitle is `content.tertiary` so the identity carries the weight and the
 * label recedes — the same hierarchy the README hero uses under its wordmark.
 */
export function BrandMark({ subtitle }: { subtitle?: string }) {
  return (
    <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
      <Logo size={24} />
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '0' })}>
        <Wordmark />
        {subtitle ? (
          <span className={css({ textStyle: 'micro', color: 'content.tertiary', mt: '-0.5' })}>
            {subtitle}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The empty-state graphic.
 *
 * A dashed card holding a faint version of the prompt mark — "swisscode,
 * nothing here yet" rather than a bare line of text. Drawn from border and
 * brand tokens so it adapts to both themes; the mark sits at low opacity so it
 * reads as a watermark, not a status. Paired with copy by the `Empty` primitive.
 */
export function EmptyGraphic({ size = 72 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      className={css({ display: 'block' })}
    >
      <rect
        x="10"
        y="10"
        width="80"
        height="80"
        rx="16"
        fill="none"
        stroke="var(--colors-border-strong)"
        strokeWidth="2"
        strokeDasharray="6 7"
      />
      <g opacity="0.5">
        <path
          d="M36 38 L54 50 L36 62"
          fill="none"
          stroke="var(--colors-brand-mark)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="60" y="44" width="10" height="13" rx="2.5" fill="var(--colors-brand-mark)" />
      </g>
    </svg>
  )
}

/** The empty-state layout: the graphic above a line of copy, centred. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '3',
        py: '8',
        px: '4',
        textAlign: 'center',
      })}
    >
      <EmptyGraphic />
      <p className={css({ textStyle: 'body', color: 'content.tertiary', maxW: 'content' })}>
        {children}
      </p>
    </div>
  )
}
