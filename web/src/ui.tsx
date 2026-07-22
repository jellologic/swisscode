// Shared primitives. Small on purpose — the Linear look is mostly restraint,
// so there are few components and they are reused rather than varied.
import type { ReactNode } from 'react'
import { css, cx } from '../styled-system/css'

export const row = css({
  display: 'flex',
  alignItems: 'center',
  gap: '2',
})

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={css({
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        px: '3',
        height: '28px',
        borderRadius: 'md',
        border: '1px solid',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
        _disabled: { opacity: 0.45, cursor: 'not-allowed' },
        ...(variant === 'primary'
          ? {
              bg: 'accent',
              borderColor: 'accent',
              color: 'white',
              _hover: { bg: 'accentHover', borderColor: 'accentHover' },
            }
          : variant === 'danger'
            ? {
                bg: 'transparent',
                borderColor: 'line',
                color: 'danger',
                _hover: { bg: 'hover', borderColor: 'lineStrong' },
              }
            : {
                bg: 'raised',
                borderColor: 'line',
                color: 'text',
                _hover: { bg: 'hover', borderColor: 'lineStrong' },
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
      <div className={css({ fontSize: '12px', fontWeight: 500, color: 'dim', mb: '1.5' })}>
        {label}
      </div>
      {children}
      {hint ? (
        <div className={css({ fontSize: '11.5px', color: 'faint', mt: '1.5', lineHeight: 1.5 })}>
          {hint}
        </div>
      ) : null}
    </label>
  )
}

export const inputStyle = css({
  width: '100%',
  bg: 'bg',
  border: '1px solid',
  borderColor: 'line',
  borderRadius: 'md',
  color: 'text',
  font: 'inherit',
  fontSize: '13px',
  px: '2.5',
  height: '30px',
  outline: 'none',
  transition: 'border-color 120ms ease',
  _focus: { borderColor: 'accent' },
  _placeholder: { color: 'faint' },
})

export const monoInput = cx(inputStyle, css({ fontFamily: 'mono', fontSize: '12.5px' }))

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section
      className={css({
        bg: 'panel',
        border: '1px solid',
        borderColor: 'line',
        borderRadius: 'lg',
        mb: '5',
      })}
    >
      <header
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: '4',
          height: '42px',
          borderBottom: '1px solid',
          borderColor: 'line',
        })}
      >
        <h2 className={css({ fontSize: '13px', fontWeight: 600, letterSpacing: '-0.01em' })}>
          {title}
        </h2>
        {action}
      </header>
      <div className={css({ p: '4' })}>{children}</div>
    </section>
  )
}

/** A status dot. Colour is reserved for exactly this kind of signal. */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'faint' }) {
  return (
    <span
      className={css({
        w: '6px',
        h: '6px',
        borderRadius: '50%',
        display: 'inline-block',
        flexShrink: 0,
      })}
      style={{
        background: `var(--colors-${tone === 'faint' ? 'faint' : tone})`,
      }}
    />
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className={css({ color: 'faint', fontSize: '13px', py: '2' })}>{children}</p>
  )
}

/** Errors are rendered, never swallowed — a refused save must be visible. */
export function Banner({ tone, children }: { tone: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={css({
        border: '1px solid',
        borderRadius: 'md',
        px: '3',
        py: '2',
        mb: '4',
        fontSize: '12.5px',
        lineHeight: 1.55,
        bg: 'raised',
        borderColor: tone === 'danger' ? 'danger' : 'warn',
        color: 'text',
      })}
    >
      {children}
    </div>
  )
}
