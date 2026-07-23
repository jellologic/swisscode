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
import type { ReactNode } from 'react'
import { css, cx } from '../styled-system/css'
import { cva } from '../styled-system/css'

/** Tones that map to a status colour. Shared so a component cannot invent one. */
export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'neutral'

export const row = css({ display: 'flex', alignItems: 'center', gap: '2' })

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
        border: '[1px solid]',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        // Only the properties that actually change. `transition: all` animates
        // layout too, which is how a hover state becomes a repaint of the row.
        transitionProperty: 'colors',
        transitionDuration: 'fast',
        _disabled: { opacity: 0.45, cursor: 'not-allowed' },
        ...(variant === 'primary'
          ? {
              bg: 'accent.default',
              borderColor: 'accent.default',
              // Not `white`: in light mode the accent is dark and the label
              // must be light, in dark mode the reverse. That is what the
              // inverse token is for.
              color: 'surface.panel',
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
      <div
        className={css({
          textStyle: 'meta',
          fontWeight: 'medium',
          color: 'content.secondary',
          mb: '1.5',
        })}
      >
        {label}
      </div>
      {children}
      {hint ? (
        <div className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '1.5' })}>
          {hint}
        </div>
      ) : null}
    </label>
  )
}

export const inputStyle = css({
  width: '[100%]',
  bg: 'surface.canvas',
  border: '[1px solid]',
  borderColor: 'border.default',
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

export const monoInput = cx(inputStyle, css({ textStyle: 'code' }))

export function Panel({
  title,
  action,
  children,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className={css({
        bg: 'surface.panel',
        border: '[1px solid]',
        borderColor: 'border.subtle',
        borderRadius: 'lg',
        mb: '5',
        // No shadow. Structure comes from the hairline, which is what keeps a
        // dense list of panels from looking like a pile of floating cards.
        overflow: 'hidden',
      })}
    >
      {title ? (
        <header
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '3',
            px: '4',
            py: '2.5',
            borderBottom: '[1px solid]',
            borderColor: 'border.subtle',
          })}
        >
          <h2 className={css({ textStyle: 'heading' })}>{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={css({ p: '4' })}>{children}</div>
    </section>
  )
}

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

export function Empty({ children }: { children: ReactNode }) {
  return <p className={css({ color: 'content.tertiary', textStyle: 'body', py: '2' })}>{children}</p>
}

/** Errors are rendered, never swallowed — a refused save must be visible. */
export function Banner({ tone, children }: { tone: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        css({
          border: '[1px solid]',
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

/** One row in a list. The hairline separator lives here so lists stay uniform. */
export function ListRow({ children }: { children: ReactNode }) {
  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '3',
        py: '2.5',
        borderBottom: '[1px solid]',
        borderColor: 'border.subtle',
        _last: { borderBottom: 'none' },
      })}
    >
      {children}
    </div>
  )
}
