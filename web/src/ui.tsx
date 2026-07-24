// The component layer.
//
// Small on purpose. The look these were measured from is mostly restraint, so
// there are few primitives and they are reused rather than varied — a codebase
// with fifteen button variants has no design system, it has fifteen buttons.
//
// EVERY VALUE HERE NAMES A TOKEN, which is not a convention but a compile
// error: `strictTokens` is on in panda.config.ts, so a stray `'13px'` or
// `'#fff'` fails typecheck. The `Dot` below used to set its colour through an
// inline `style` with an interpolated CSS variable — the one construct that
// escapes the type system entirely — and that is exactly what this rule exists
// to catch.
//
// NOTHING HERE OWNS ITS OUTER MARGIN except the three things that mark a
// screen's skeleton — `PageHeader`, `Panel`, `Toolbar`, `FormActions`. Spacing
// between siblings is `Stack`'s job. A component that carries its own `mb` is a
// component every caller has to fight the moment it appears somewhere else, and
// it is how seven screens end up with seven vertical rhythms.
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { css, cva, cx } from '../styled-system/css'

/** Tones that map to a status colour. Shared so a component cannot invent one. */
export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'neutral'

/**
 * The gaps a layout may ask for, from the spacing scale.
 *
 * Deliberately a short list. `Stack gap="3"` and `Stack gap="4"` are a rhythm;
 * eleven choices are an invitation to eyeball it, which is the same failure as
 * an arbitrary margin with extra steps.
 */
export type Gap = '0' | '1' | '1.5' | '2' | '3' | '4' | '5' | '6'

// Shared by `Stack` and `Inline`. Written out per value rather than generated
// because Panda is a build-time extractor: a gap it can only learn at runtime
// emits no CSS at all.
const GAPS = {
  '0': { gap: '0' },
  '1': { gap: '1' },
  '1.5': { gap: '1.5' },
  '2': { gap: '2' },
  '3': { gap: '3' },
  '4': { gap: '4' },
  '5': { gap: '5' },
  '6': { gap: '6' },
} as const

/* ------------------------------------------------------------------ layout */

const stack = cva({
  base: { display: 'flex', flexDirection: 'column', minW: '0' },
  variants: {
    gap: GAPS,
    align: {
      stretch: { alignItems: 'stretch' },
      start: { alignItems: 'flex-start' },
      center: { alignItems: 'center' },
    },
  },
  defaultVariants: { gap: '3', align: 'stretch' },
})

/** Vertical rhythm, named. The only sanctioned way to space siblings apart. */
export function Stack({
  gap,
  align,
  children,
}: {
  gap?: Gap
  align?: 'stretch' | 'start' | 'center'
  children: ReactNode
}) {
  return <div className={stack({ gap, align })}>{children}</div>
}

const inline = cva({
  base: { display: 'flex', minW: '0' },
  variants: {
    gap: GAPS,
    align: {
      center: { alignItems: 'center' },
      baseline: { alignItems: 'baseline' },
      start: { alignItems: 'flex-start' },
      stretch: { alignItems: 'stretch' },
    },
    justify: {
      start: { justifyContent: 'flex-start' },
      between: { justifyContent: 'space-between' },
      end: { justifyContent: 'flex-end' },
    },
    wrap: { true: { flexWrap: 'wrap' }, false: { flexWrap: 'nowrap' } },
  },
  defaultVariants: { gap: '2', align: 'center', justify: 'start', wrap: false },
})

/** Horizontal grouping, named. `Inline` is to a row what `Stack` is to a column. */
export function Inline({
  gap,
  align,
  justify,
  wrap,
  children,
}: {
  gap?: Gap
  align?: 'center' | 'baseline' | 'start' | 'stretch'
  justify?: 'start' | 'between' | 'end'
  wrap?: boolean
  children: ReactNode
}) {
  return <div className={inline({ gap, align, justify, wrap })}>{children}</div>
}

/**
 * The top of every screen.
 *
 * One component so that seven screens cannot disagree about how far the title
 * sits above the content, which is the kind of difference nobody can name and
 * everybody sees. The title is `title` (20px) rather than the `heading` (15px)
 * the panels use, so the page reads title → panel → row without anything
 * needing a rule under it.
 */
export function PageHeader({
  title,
  meta,
  description,
  actions,
  onBack,
}: {
  title: ReactNode
  /** A short fact about the page — a count, a source, a version. Sits beside the title. */
  meta?: ReactNode
  /** A sentence or two. Measure-limited, because prose the width of the page is unreadable. */
  description?: ReactNode
  actions?: ReactNode
  /** When set, renders the standard back control. Editor views pass their cancel handler. */
  onBack?: () => void
}) {
  return (
    <header className={css({ mb: '5' })}>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '3', minH: 'control' })}>
        {onBack ? (
          <span className={css({ flexShrink: 0 })}>
            <Button onClick={onBack}>← Back</Button>
          </span>
        ) : null}
        <div
          className={css({
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '2',
            flex: '1',
            minW: '0',
          })}
        >
          <h1 className={css({ textStyle: 'title' })}>{title}</h1>
          {meta ? (
            <span className={css({ textStyle: 'meta', color: 'content.tertiary' })}>{meta}</span>
          ) : null}
        </div>
        {actions ? (
          <div className={css({ display: 'flex', alignItems: 'center', gap: '2', flexShrink: 0 })}>
            {actions}
          </div>
        ) : null}
      </div>
      {description ? (
        <p className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '2', maxW: 'content' })}>
          {description}
        </p>
      ) : null}
    </header>
  )
}

/**
 * A row of controls: search, filters, buttons.
 *
 * Everything in it is 32px tall, so the row has one baseline rather than three.
 * `end` is pushed to the right edge; put the count or the destructive action
 * there, not in the middle of the group.
 */
export function Toolbar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '2',
        flexWrap: 'wrap',
        mb: '4',
      })}
    >
      {children}
      {end ? (
        <div className={css({ ml: 'auto', display: 'flex', alignItems: 'center', gap: '2' })}>
          {end}
        </div>
      ) : null}
    </div>
  )
}

/** The footer of an editor: primary action first, then the way out. */
export function FormActions({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className={css({ display: 'flex', alignItems: 'center', gap: '2', mb: '10' })}>
      {children}
      {end ? (
        <div className={css({ ml: 'auto', display: 'flex', alignItems: 'center', gap: '2' })}>
          {end}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ panels */

export function Panel({
  title,
  description,
  action,
  flush,
  children,
}: {
  title?: string
  /** Explains the panel, not a field in it. Renders inside the header, above the hairline. */
  description?: ReactNode
  action?: ReactNode
  /**
   * Drop the body padding, so a `DataList` runs edge to edge.
   *
   * A `DataRow` carries its own gutter; nesting one inside a padded body insets
   * it twice and stops the separators short of the panel's own hairline, which
   * is the difference between a list and a stack of boxes.
   */
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={css({
        bg: 'surface.panel',
        // `borders.hairline`, not a bare `1px solid` next to a `borderColor` —
        // see the token's own note in panda.config.ts. That pairing is a race
        // the shorthand can win, and when it does the border paints in
        // `currentColor`.
        border: 'hairline',
        borderRadius: 'lg',
        mb: '5',
        // No shadow. Structure comes from the hairline, which is what keeps a
        // dense list of panels from looking like a pile of floating cards.
        overflow: 'hidden',
      })}
    >
      {title || description || action ? (
        <header
          className={css({
            px: '4',
            py: '2.5',
            borderBottom: 'hairline',
          })}
        >
          <div className={css({ display: 'flex', alignItems: 'center', gap: '3' })}>
            {title ? (
              <h2 className={css({ textStyle: 'heading', flex: '1', minW: '0' })}>{title}</h2>
            ) : null}
            {action ? (
              <div className={css({ ml: 'auto', display: 'flex', alignItems: 'center', gap: '2' })}>
                {action}
              </div>
            ) : null}
          </div>
          {description ? (
            <p
              className={css({
                textStyle: 'meta',
                color: 'content.tertiary',
                mt: '1.5',
                maxW: 'content',
              })}
            >
              {description}
            </p>
          ) : null}
        </header>
      ) : null}
      <div className={flush ? undefined : css({ p: '4' })}>{children}</div>
    </section>
  )
}

/**
 * A dialog over the page.
 *
 * Closes on the backdrop only: there is deliberately no Escape handler here,
 * because the one dialog in the app does not have one today and this is a
 * visual pass. Add it in the route if you want it, and say so.
 */
export function Modal({
  onClose,
  label,
  children,
}: {
  onClose: () => void
  label?: string
  children: ReactNode
}) {
  return (
    <div
      className={css({
        position: 'fixed',
        inset: '0',
        bg: 'surface.overlay',
        display: 'grid',
        placeItems: 'center',
        p: '6',
        zIndex: 'modal',
      })}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={css({
          bg: 'surface.panel',
          border: 'strong',
          borderRadius: 'lg',
          w: 'full',
          maxW: 'content',
          maxH: '[80vh]',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- lists */

/**
 * The container for `DataRow`s.
 *
 * Its real job is making the rows SIBLINGS, which is what lets each row drop
 * its own bottom hairline through `_last` without a divider ending up flush
 * against the panel's border.
 */
export function DataList({ children }: { children: ReactNode }) {
  return <div className={css({ display: 'flex', flexDirection: 'column' })}>{children}</div>
}

const dataRow = cva({
  base: {
    display: 'flex',
    gap: '3',
    // The gutter lives on the row, not on a padded panel body, so the hover
    // tint and the separator reach the panel's own edge.
    px: '4',
    py: '2.5',
    borderBottom: 'hairline',
    _last: { borderBottom: 'none' },
  },
  variants: {
    align: { center: { alignItems: 'center' }, start: { alignItems: 'flex-start' } },
    hover: {
      true: {
        transitionProperty: 'colors',
        transitionDuration: 'fast',
        _hover: { bg: 'surface.hover' },
      },
      false: {},
    },
  },
  defaultVariants: { align: 'center', hover: false },
})

// A dot is 6px against a first line that is 17-19px tall, so top-aligning it
// literally puts it above the text. 6px down is the optical centre of that line.
const rowLeading = cva({
  base: { flexShrink: 0, display: 'flex', alignItems: 'center' },
  variants: { align: { center: {}, start: { alignSelf: 'flex-start', mt: '1.5' } } },
  defaultVariants: { align: 'center' },
})

const rowActions = cva({
  base: { display: 'flex', alignItems: 'center', gap: '2', flexShrink: 0 },
  variants: { align: { center: {}, start: { alignSelf: 'flex-start' } } },
  defaultVariants: { align: 'center' },
})

/**
 * One row of a list — the shape every screen here repeats.
 *
 * Three columns: a status marker, the body, and the actions. Fixing the columns
 * is the point: a list whose left edge moves by two pixels per row reads as
 * unstyled no matter what the rows contain.
 */
export function DataRow({
  leading,
  title,
  meta,
  actions,
  align = 'center',
  hover,
  children,
}: {
  /** Usually a `Dot`. Omit it and the body starts at the gutter. */
  leading?: ReactNode
  /** The identifier. One line, `body` weight medium. */
  title?: ReactNode
  /** The line under it: what it resolves to, who uses it, why it is broken. */
  meta?: ReactNode
  actions?: ReactNode
  /** `start` for rows whose body is several lines tall; it also drops the dot onto the first line. */
  align?: 'center' | 'start'
  /** Only when the row itself is a target. A hover tint on an inert row is a lie. */
  hover?: boolean
  /** Anything below `meta` — a measurement, a description, a fix. */
  children?: ReactNode
}) {
  return (
    <div className={dataRow({ align, hover })}>
      {leading ? <div className={rowLeading({ align })}>{leading}</div> : null}
      <div className={css({ flex: '1', minW: '0' })}>
        {title ? (
          <div className={css({ textStyle: 'body', fontWeight: 'medium', color: 'content.primary' })}>
            {title}
          </div>
        ) : null}
        {meta ? (
          <div className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '0.5' })}>
            {meta}
          </div>
        ) : null}
        {children}
      </div>
      {actions ? <div className={rowActions({ align })}>{actions}</div> : null}
    </div>
  )
}

/** Wraps a `DataRow` list. Shares the row's gutter so the text starts on the same edge. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className={css({ color: 'content.tertiary', textStyle: 'body', px: '4', py: '4', maxW: 'content' })}>
      {children}
    </p>
  )
}

/* --------------------------------------------------------------- key/value */

/** The container for `KeyValue`. A `<dl>`, because that is what this is. */
export function KeyValueList({ children }: { children: ReactNode }) {
  return (
    <dl className={css({ display: 'flex', flexDirection: 'column', gap: '2', m: '0' })}>
      {children}
    </dl>
  )
}

const keyValueValue = cva({
  base: { flex: '1', minW: '0' },
  variants: {
    // Mono and sans are both 12px here, so an id and a sentence sit on the same
    // line without either one jumping.
    mono: { true: { textStyle: 'code' }, false: { textStyle: 'meta' } },
    tone: {
      default: { color: 'content.primary' },
      neutral: { color: 'content.tertiary' },
      ok: { color: 'ok.default' },
      warn: { color: 'warn.default' },
      danger: { color: 'danger.default' },
      accent: { color: 'accent.default' },
    },
  },
  defaultVariants: { mono: false, tone: 'default' },
})

/**
 * A label and what it is. Describes an account, a profile, a report.
 *
 * The labels share one column (`sizes.keyColumn`) so the values line up; that
 * alignment is the whole reason to reach for this over two spans and a middot.
 */
export function KeyValue({
  label,
  mono,
  tone,
  children,
}: {
  label: ReactNode
  /** For paths, ids, hostnames — anything meant to be read character by character. */
  mono?: boolean
  /** Colour the VALUE only, and only when the value is a status. */
  tone?: 'default' | Tone
  children: ReactNode
}) {
  return (
    <div className={css({ display: 'flex', gap: '3', alignItems: 'baseline' })}>
      <dt
        className={css({
          w: 'keyColumn',
          flexShrink: 0,
          textStyle: 'meta',
          color: 'content.tertiary',
        })}
      >
        {label}
      </dt>
      {/*
        `minW: '0'` because a <dd> is a flex item, and a flex item's automatic
        minimum size is its MIN-CONTENT: one unbreakable account name or path
        sets a floor the whole page cannot shrink below. That floor is what made
        the Profiles screen the only one to force a document-wide horizontal
        scrollbar under an 864px viewport.
      */}
      <dd className={cx(keyValueValue({ mono, tone }), css({ m: '0', minW: '0' }))}>{children}</dd>
    </div>
  )
}

/* ----------------------------------------------------------------- controls */

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  size = 'md',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  size?: 'md' | 'sm'
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={css({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '1.5',
        textStyle: 'body',
        fontWeight: 'medium',
        px: size === 'sm' ? '2' : '3',
        height: size === 'sm' ? 'controlSm' : 'control',
        borderRadius: 'sm',
        // WIDTH AND STYLE ONLY, never the `border` shorthand: the colour is a
        // variant here, so it has to stay a `borderColor` of its own, and a
        // shorthand beside it would reset that colour to `currentColor` the
        // moment the extractor happened to emit it last. Longhands reset
        // nothing, so this composition is order-independent.
        borderWidth: 'hairline',
        borderStyle: 'solid',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        // Only the properties that actually change. `transition: all` animates
        // layout too, which is how a hover state becomes a repaint of the row.
        transitionProperty: 'colors',
        transitionDuration: 'fast',
        /**
         * MUTE THE FILL, NOT THE PAIR.
         *
         * This was `opacity: 0.45`, which fades a button and its label together
         * toward the page behind them — it does not mute a control, it dissolves
         * it. Measured off the rendered pixels, a disabled primary button read
         * 1.87:1 in light and 2.01:1 in dark, and that is the state the "Create
         * account" button is in for the entire time the form is being filled in.
         * Naming the disabled surface and the disabled ink instead keeps the
         * label at 4.5:1 in both themes while the flat grey still says inactive.
         *
         * `&:disabled:hover` IS NOT REDUNDANT. `:hover` still matches a disabled
         * button — the pointer is over it, it merely cannot be clicked — and
         * Panda compiles `_hover` and `_disabled` to selectors of EQUAL
         * specificity, so a variant's hover would repaint the fill this block
         * just muted while the label stayed tertiary. Which of the two won would
         * come down to emission order again. The compound selector settles it by
         * specificity, which is the thing that does not move.
         */
        '&:disabled, &:disabled:hover': {
          cursor: 'not-allowed',
          bg: 'surface.hover',
          borderColor: 'border.default',
          color: 'content.tertiary',
        },
        ...(variant === 'primary'
          ? {
              bg: 'accent.default',
              borderColor: 'accent.default',
              // Not `white`: in light mode the accent is dark and the label
              // must be light, in dark mode the reverse. That is what the
              // inverse token is for — and this used to name `surface.panel`,
              // a SURFACE role deciding a text colour, which happens to
              // resolve to nearly the same two values and would have silently
              // repainted every primary label the day a panel changed.
              color: 'content.inverse',
              _hover: { bg: 'accent.hover', borderColor: 'accent.hover' },
            }
          : variant === 'danger'
            ? {
                bg: 'transparent',
                borderColor: 'border.default',
                color: 'danger.default',
                _hover: { bg: 'danger.subtle', borderColor: 'danger.default' },
              }
            : variant === 'ghost'
              ? {
                  bg: 'transparent',
                  borderColor: 'transparent',
                  color: 'content.secondary',
                  _hover: { bg: 'surface.hover', color: 'content.primary' },
                }
              : {
                  bg: 'surface.raised',
                  borderColor: 'border.default',
                  color: 'content.primary',
                  _hover: { bg: 'surface.hover', borderColor: 'border.strong' },
                }),
      })}
    >
      {children}
    </button>
  )
}

const segmentTrack = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'stretch',
    bg: 'surface.hover',
    borderRadius: 'sm',
    p: '0.5',
    gap: '0.5',
  },
  variants: {
    // The TRACK owns the height and the segments stretch into it, so `md` is
    // exactly 32px — the same as every button beside it in a `Toolbar`.
    size: { sm: {}, md: { height: 'control' } },
    // `stretch`, not `fill`: `fill` is an SVG CSS property, and a boolean prop
    // named after one is a trap for any build-time extractor reading JSX props.
    stretch: { true: { display: 'flex', width: 'full' }, false: {} },
  },
  defaultVariants: { size: 'md', stretch: false },
})

const segment = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    font: 'inherit',
    border: 'none',
    borderRadius: 'xs',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'colors',
    transitionDuration: 'fast',
    bg: 'transparent',
    color: 'content.tertiary',
    _hover: { color: 'content.primary' },
  },
  variants: {
    size: { sm: { textStyle: 'micro', px: '2', py: '1' }, md: { textStyle: 'meta', px: '3' } },
    // The selected segment is raised out of the track rather than tinted: this
    // is a choice of view, not a status, and colour is reserved for status.
    selected: { true: { bg: 'surface.panel', color: 'content.primary' }, false: {} },
    stretch: { true: { flex: '1' }, false: {} },
  },
  defaultVariants: { size: 'md', selected: false, stretch: false },
})

/**
 * One choice out of a few, all visible at once.
 *
 * For MUTUALLY EXCLUSIVE views — light/dark, a sort order, a mode. A filter the
 * user can turn on alongside another one is not this; that is `ToggleChip`.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size,
  stretch,
  label,
  labelledBy,
}: {
  options: readonly { id: T; label: ReactNode }[]
  value: T
  onChange: (id: T) => void
  /** `sm` for the sidebar, `md` (default, 32px) for anything on a page. */
  size?: 'sm' | 'md'
  /** Stretch to the container's width, splitting it evenly. */
  stretch?: boolean
  /** Accessible name, when the group has no visible caption of its own. */
  label?: string
  /**
   * The id of the visible caption naming this group — a `SectionLabel`, usually.
   *
   * Preferred over `label`. A group is not a form control, so there is no
   * `htmlFor` that reaches it: pointing at the caption that is already on screen
   * is what keeps the two from drifting into two different sentences, which is
   * exactly what a duplicated `aria-label` produces.
   */
  labelledBy?: string
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={segmentTrack({ size, stretch })}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={segment({ size, stretch, selected: value === o.id })}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const toggleChip = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1.5',
    height: 'control',
    px: '2.5',
    borderRadius: 'sm',
    // Longhands, because `pressed` owns the colour. See `Button`.
    borderWidth: 'hairline',
    borderStyle: 'solid',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    textStyle: 'body',
    fontWeight: 'medium',
    transitionProperty: 'colors',
    transitionDuration: 'fast',
  },
  variants: {
    // A TINT, not a filled accent button. Three filled buttons in a row is
    // three primary actions, and a screen with three primary actions has none.
    pressed: {
      true: { bg: 'accent.subtle', borderColor: 'accent.default', color: 'accent.default' },
      false: {
        bg: 'surface.raised',
        borderColor: 'border.default',
        color: 'content.secondary',
        _hover: { borderColor: 'border.strong', color: 'content.primary' },
      },
    },
  },
  defaultVariants: { pressed: false },
})

/** An independently on/off filter. Several may be pressed at once. */
export function ToggleChip({
  pressed,
  onClick,
  count,
  children,
}: {
  pressed: boolean
  onClick: () => void
  /** How many rows this filter would admit. Rendered subdued, after the label. */
  count?: number
  children: ReactNode
}) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={toggleChip({ pressed })}>
      {children}
      {count === undefined ? null : (
        <span className={css({ textStyle: 'meta', color: 'content.tertiary' })}>{count}</span>
      )}
    </button>
  )
}

/**
 * The one input box, as a STYLE OBJECT rather than a class string.
 *
 * `css.raw` is the difference between composing styles and concatenating
 * classes. `cx(inputStyle, css({ textStyle: 'code' }))` put TWO composition
 * classes on one element — `.textStyle_body` and `.textStyle_code`, which
 * disagree about font-size and tracking — and left the winner to emission
 * order inside `@layer utilities`, which is EXTRACTION order: not config order,
 * not the order of the `cx` arguments. It resolved correctly only because
 * App.tsx happens to mention `body` before anything mentions `code`, and
 * deleting an unrelated line elsewhere could flip it with no type error and no
 * failing test. Handing Panda the objects lets it merge them at build time into
 * one class, which has one answer.
 */
const inputBase = css.raw({
  width: 'full',
  bg: 'surface.canvas',
  border: 'default',
  borderRadius: 'sm',
  color: 'content.primary',
  textStyle: 'body',
  px: '2.5',
  height: 'control',
  outline: 'none',
  transitionProperty: 'colors',
  transitionDuration: 'fast',
  _hover: { borderColor: 'border.strong' },
  _focus: { borderColor: 'accent.default', bg: 'surface.panel' },
  _placeholder: { color: 'content.tertiary' },
})

export const inputStyle = css(inputBase)

/** For paths, ids and keys. One class, so there is nothing left to race. */
export const monoInput = css(inputBase, { textStyle: 'code' })

/** A `<select>`. Same box as an input so a form of mixed controls has one edge. */
export const selectStyle = css(inputBase, { cursor: 'pointer' })

const searchWidth = css({ maxW: 'search' })
const searchGrow = css({ flex: '1' })

/**
 * The search box in a `Toolbar`.
 *
 * Bounded rather than full-width, and carrying the glyph, because a bare
 * 100%-wide input beside two buttons reads as a form somebody forgot to finish.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
  grow,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Accessible name. Falls back to the placeholder, which is not a label but is better than nothing. */
  label?: string
  autoFocus?: boolean
  /** Fill the remaining width instead of stopping at `sizes.search`. */
  grow?: boolean
}) {
  return (
    <div
      className={cx(
        css({ position: 'relative', display: 'flex', alignItems: 'center', minW: '0' }),
        grow ? searchGrow : searchWidth,
      )}
    >
      <span
        aria-hidden="true"
        className={css({
          position: 'absolute',
          left: '2.5',
          display: 'flex',
          color: 'content.tertiary',
          pointerEvents: 'none',
        })}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="5.2" cy="5.2" r="3.6" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 8L10.6 10.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="text"
        autoFocus={autoFocus}
        aria-label={label ?? placeholder ?? 'Search'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={css(inputBase, { pl: '7' })}
      />
    </div>
  )
}

/**
 * The type of a control's label, spelled once.
 *
 * Exported because a label is not always a `Field`: a grid that shares one
 * column across four inputs needs a real `<label htmlFor>` in a cell of its own,
 * and `SectionLabel` is the same treatment over a group rather than a control.
 * Three copies of `meta` + `medium` + `content.secondary` is how the rung a
 * label sits on stops being one rung.
 */
export const labelStyle = css({
  textStyle: 'meta',
  fontWeight: 'medium',
  color: 'content.secondary',
})

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}) {
  return (
    <label className={css({ display: 'block', mb: '4' })}>
      <div className={cx(labelStyle, css({ mb: '1.5' }))}>{label}</div>
      {children}
      {hint ? (
        <div className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '1.5' })}>
          {hint}
        </div>
      ) : null}
    </label>
  )
}

const choiceLabel = css({
  display: 'block',
  textStyle: 'body',
  color: 'content.primary',
  cursor: 'pointer',
})
const choiceRow = css({ display: 'flex', gap: '2', alignItems: 'center' })
// The native control is left native — it is accessible, it is themed by
// `accentColor` in both modes, and every hand-built replacement in this class of
// app is worse at exactly one thing nobody notices until they need it.
const choiceInput = css({ accentColor: 'accent.default', cursor: 'pointer', m: '0', flexShrink: 0 })
// Indented past the box so the note reads as belonging to the label, not to the
// next one down.
const choiceNote = cva({
  base: { display: 'block', pl: '6', mt: '0.5', textStyle: 'meta', maxW: 'content' },
  variants: {
    tone: {
      default: { color: 'content.tertiary' },
      warn: { color: 'warn.default' },
      danger: { color: 'danger.default' },
    },
  },
  defaultVariants: { tone: 'default' },
})

/** A checkbox and its label, with the explanation indented under it. */
export function Checkbox({
  checked,
  onChange,
  label,
  note,
  noteTone,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  /** What it costs or what it means. Reserve `warn` for a trade-off, not for emphasis. */
  note?: ReactNode
  noteTone?: 'default' | 'warn' | 'danger'
  disabled?: boolean
}) {
  return (
    <label className={choiceLabel}>
      <span className={choiceRow}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className={choiceInput}
        />
        <span>{label}</span>
      </span>
      {note ? <span className={choiceNote({ tone: noteTone })}>{note}</span> : null}
    </label>
  )
}

/** One option of a radio group. Wrap the set in a `Stack` — the gap is not its business. */
export function Radio({
  name,
  checked,
  onSelect,
  label,
  note,
  noteTone,
  disabled,
}: {
  /** Shared by the group. Without it the browser will not treat them as one choice. */
  name: string
  checked: boolean
  onSelect: () => void
  label: ReactNode
  note?: ReactNode
  noteTone?: 'default' | 'warn' | 'danger'
  disabled?: boolean
}) {
  return (
    <label className={choiceLabel}>
      <span className={choiceRow}>
        <input
          type="radio"
          name={name}
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
          className={choiceInput}
        />
        <span>{label}</span>
      </span>
      {note ? <span className={choiceNote({ tone: noteTone })}>{note}</span> : null}
    </label>
  )
}

/**
 * Copy one string to the clipboard and say so for a moment.
 *
 * The timer is cleared on unmount as well as on re-click: a filtered list
 * unmounts rows while their timeout is still pending, and setting state on a
 * gone component is the classic way this leaks.
 */
export function CopyButton({
  value,
  label = 'copy',
  copiedLabel = 'copied',
}: {
  value: string
  label?: string
  copiedLabel?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
      className={css({
        textStyle: 'micro',
        color: copied ? 'ok.default' : 'content.tertiary',
        bg: 'transparent',
        border: 'none',
        borderRadius: 'xs',
        px: '1',
        py: '0.5',
        cursor: 'pointer',
        transitionProperty: 'colors',
        transitionDuration: 'fast',
        _hover: { color: 'content.primary', bg: 'surface.hover' },
      })}
    >
      {copied ? copiedLabel : label}
    </button>
  )
}

/* --------------------------------------------------------------------- text */

/** A literal inside a sentence: a command, a filename, a config key. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code
      className={css({
        textStyle: 'code',
        bg: 'surface.hover',
        color: 'content.primary',
        px: '1',
        py: '0.5',
        borderRadius: 'xs',
        wordBreak: 'break-word',
      })}
    >
      {children}
    </code>
  )
}

/**
 * Monospace, and NOTHING else — it inherits its colour.
 *
 * That is the point: the same component works inside a tertiary meta line and
 * inside a primary title, so a provider id does not have to pick a colour to
 * get the right metrics. It is also the correct home for the `fontFamily: mono`
 * that was being pasted next to `textStyle: 'meta'`, which applied the sans
 * tracking curve to monospace — the one thing the type scale forbids.
 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className={css({ textStyle: 'code' })}>{children}</span>
}

const note = cva({
  base: { textStyle: 'meta', m: '0' },
  variants: {
    tone: {
      default: { color: 'content.tertiary' },
      warn: { color: 'warn.default' },
      danger: { color: 'danger.default' },
      ok: { color: 'ok.default' },
    },
    measure: { true: { maxW: 'content' }, false: {} },
  },
  defaultVariants: { tone: 'default', measure: true },
})

/** Explanatory prose. Measure-limited by default: a line the full `sizes.main` is unreadable. */
export function Note({
  tone,
  measure,
  children,
}: {
  /** Colour is the claim that this is a WARNING, not that it matters. Most notes are `default`. */
  tone?: 'default' | 'warn' | 'danger' | 'ok'
  measure?: boolean
  children: ReactNode
}) {
  return <p className={note({ tone, measure })}>{children}</p>
}

/**
 * A label over a group of controls inside a panel — one step below `Panel title`.
 *
 * Takes an `id` so a group that is not a form control — a `SegmentedControl`,
 * which has no `htmlFor` to receive — can point `aria-labelledby` at the caption
 * the user can actually see, rather than carrying a second copy of it.
 */
export function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className={labelStyle}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------- status */

/**
 * A status dot. Colour is reserved for exactly this kind of signal.
 *
 * `cva` RATHER THAN AN OBJECT LOOKUP, and the reason is a bug this shipped with
 * for exactly one build: `css({ bg: DOT_BG[tone] })` typechecks perfectly and
 * renders NOTHING. Panda is a build-time extractor — it reads the literal
 * arguments in your source and emits those classes — so a value it can only
 * learn at runtime produces no CSS at all. The dot rendered 6px wide and fully
 * transparent.
 *
 * A recipe is the sanctioned shape for exactly this: the variants are literal
 * at build time, so the CSS exists, and the prop stays typed against them.
 */
const dot = cva({
  base: {
    w: '1.5',
    h: '1.5',
    borderRadius: 'full',
    display: 'inline-block',
    flexShrink: 0,
  },
  variants: {
    tone: {
      ok: { bg: 'ok.default' },
      warn: { bg: 'warn.default' },
      danger: { bg: 'danger.default' },
      accent: { bg: 'accent.default' },
      neutral: { bg: 'content.tertiary' },
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Dot({ tone }: { tone: Tone }) {
  return <span className={dot({ tone })} />
}

/** A small text label carrying a status colour. Same recipe rule as `Dot`. */
const badge = cva({
  base: {
    textStyle: 'micro',
    px: '1.5',
    py: '0.5',
    borderRadius: 'xs',
    whiteSpace: 'nowrap',
    display: 'inline-block',
  },
  variants: {
    tone: {
      ok: { bg: 'ok.subtle', color: 'ok.default' },
      warn: { bg: 'warn.subtle', color: 'warn.default' },
      danger: { bg: 'danger.subtle', color: 'danger.default' },
      accent: { bg: 'accent.subtle', color: 'accent.default' },
      neutral: { bg: 'surface.hover', color: 'content.tertiary' },
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={badge({ tone })}>{children}</span>
}

/** Errors are rendered, never swallowed — a refused save must be visible. */
export function Banner({ tone, children }: { tone: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        css({
          // Longhands: the tone below owns `borderColor`. See `Button`.
          borderWidth: 'hairline',
          borderStyle: 'solid',
          borderRadius: 'sm',
          px: '3',
          py: '2',
          mb: '4',
          textStyle: 'meta',
          color: 'content.primary',
        }),
        css(
          tone === 'danger'
            ? { bg: 'danger.subtle', borderColor: 'danger.default' }
            : { bg: 'warn.subtle', borderColor: 'warn.default' },
        ),
      )}
    >
      {children}
    </div>
  )
}
