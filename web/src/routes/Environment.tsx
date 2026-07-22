import { useEffect, useMemo, useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type ClaudeEnvCatalog, type ClaudeEnvKind, type ClaudeEnvVar } from '../api'
import { Banner, Button, Empty, Panel, inputStyle } from '../ui'

/**
 * Every environment variable Claude Code references.
 *
 * THE CLASSIFICATION IS THE FEATURE, not a caveat bolted onto it. The list is
 * extracted from the shipped binary, which yields names and nothing else — no
 * meaning, no defaults, no proof a name is still wired to anything. So the
 * screen leads with how much is known about each entry rather than presenting
 * 495 strings as if they were equally supported knobs:
 *
 *   documented    described by hand, safe to act on
 *   undocumented  the name is real, the meaning is not known
 *   internal      test hooks, profiling, cloud auth, unreleased codenames
 *
 * A screen that hid that distinction would be actively harmful: someone would
 * set an unreleased feature codename in a profile and wonder why nothing
 * happened — or why it stopped working after an agent update.
 */

const KIND_COPY: Record<ClaudeEnvKind, { label: string; blurb: string; tone: string }> = {
  documented: {
    label: 'Documented',
    blurb: 'Described from Anthropic’s docs, `claude --help`, or swisscode’s own adapter. Safe to act on.',
    tone: 'ok',
  },
  undocumented: {
    label: 'Undocumented',
    blurb:
      'The name is real — Claude Code references it. What it does is NOT known. Deliberately shipped without a description: a plausible guess is worse than a blank, because someone acts on it.',
    tone: 'warn',
  },
  internal: {
    label: 'Internal',
    blurb:
      'Test hooks, profiling switches, third-party cloud auth, and unreleased feature codenames. Listed for completeness; not knobs to set.',
    tone: 'faint',
  },
}

export function Environment() {
  const [data, setData] = useState<ClaudeEnvCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<Set<ClaudeEnvKind>>(new Set(['documented']))

  useEffect(() => {
    let live = true
    api
      .claudeEnv()
      .then((r) => live && setData(r))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return data.variables.filter((v) => {
      if (!kinds.has(v.kind)) return false
      if (terms.length === 0) return true
      // Search the description too — "how do I cap output tokens" is a likelier
      // question than "what does MAX_OUTPUT_TOKENS do".
      const hay = `${v.name} ${v.category ?? ''} ${v.description ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [data, query, kinds])

  const counts = useMemo(() => {
    const c: Record<string, number> = { documented: 0, undocumented: 0, internal: 0 }
    for (const v of data?.variables ?? []) c[v.kind] = (c[v.kind] ?? 0) + 1
    return c
  }, [data])

  const toggle = (kind: ClaudeEnvKind) =>
    setKinds((s) => {
      const next = new Set(s)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  return (
    <>
      <div className={css({ display: 'flex', alignItems: 'baseline', gap: '3', mb: '2' })}>
        <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>Environment</h1>
        {data ? (
          <span className={css({ fontSize: '11.5px', color: 'faint', fontFamily: 'mono' })}>
            {data.variables.length} variables · extracted from {data.source.agent}{' '}
            {data.source.version}
          </span>
        ) : null}
      </div>

      <p className={css({ fontSize: '12px', color: 'faint', mb: '4', lineHeight: 1.6, maxW: '46rem' })}>
        Every environment variable this Claude Code build references. Set any of them on a profile’s{' '}
        <code>env</code> block, which is applied last and can override anything the provider sets.{' '}
        <strong className={css({ color: 'text' })}>The list is extracted from the binary</strong>, so
        it is complete on names and silent on meaning — which is what the filters below are for.
      </p>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className={css({ display: 'flex', gap: '2', mb: '3', flexWrap: 'wrap' })}>
        <input
          className={inputStyle}
          placeholder="search name or description"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={css({ display: 'flex', gap: '2', mb: '4', flexWrap: 'wrap' })}>
        {(Object.keys(KIND_COPY) as ClaudeEnvKind[]).map((kind) => (
          <Button key={kind} variant={kinds.has(kind) ? 'primary' : undefined} onClick={() => toggle(kind)}>
            {KIND_COPY[kind].label} ({counts[kind] ?? 0})
          </Button>
        ))}
      </div>

      {[...kinds].map((kind) => (
        <p
          key={kind}
          className={css({ fontSize: '11.5px', color: 'faint', mb: '2', lineHeight: 1.5, maxW: '46rem' })}
        >
          <strong className={css({ color: KIND_COPY[kind].tone === 'warn' ? 'warn' : 'faint' })}>
            {KIND_COPY[kind].label}:
          </strong>{' '}
          {KIND_COPY[kind].blurb}
        </p>
      ))}

      <Panel title={`${rows.length} shown`}>
        {!data && !error ? <Empty>Loading…</Empty> : null}
        {data && rows.length === 0 ? (
          <Empty>Nothing matches. Try a different search, or enable another category above.</Empty>
        ) : null}
        {rows.map((v) => (
          <Row key={v.name} variable={v} />
        ))}
      </Panel>
    </>
  )
}

function Row({ variable }: { variable: ClaudeEnvVar }) {
  const [copied, setCopied] = useState(false)
  return (
    <div
      className={css({
        py: '2.5',
        borderBottom: '1px solid',
        borderColor: 'line',
        _last: { borderBottom: 'none' },
      })}
    >
      <div className={css({ display: 'flex', alignItems: 'baseline', gap: '2', flexWrap: 'wrap' })}>
        <code className={css({ fontFamily: 'mono', fontSize: '12px', color: 'text' })}>
          {variable.name}
        </code>
        {/*
          "swisscode sets this" is the most useful badge on the screen: it tells
          someone the knob is already wired to a profile field, so hand-setting
          it in `env` would fight the launcher rather than configure it.
        */}
        {variable.managed ? (
          <span className={css({ fontSize: '10.5px', color: 'ok' })}>swisscode sets this</span>
        ) : null}
        {variable.category ? (
          <span className={css({ fontSize: '10.5px', color: 'faint', fontFamily: 'mono' })}>
            {variable.category}
          </span>
        ) : null}
        {variable.kind === 'internal' ? (
          <span className={css({ fontSize: '10.5px', color: 'faint' })}>{variable.why}</span>
        ) : null}
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(variable.name)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          className={css({
            ml: 'auto',
            fontSize: '10.5px',
            color: 'faint',
            cursor: 'pointer',
            bg: 'transparent',
            border: 'none',
            _hover: { color: 'text' },
          })}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {variable.description ? (
        <div className={css({ fontSize: '11.5px', color: 'faint', mt: '1', lineHeight: 1.5, maxW: '44rem' })}>
          {variable.description}
        </div>
      ) : (
        /*
          An explicit blank, not an empty cell. The absence is the finding: we
          know the name exists and we do not know what it does, and saying so is
          the honest version of a catalog built by reading a binary.
        */
        <div className={css({ fontSize: '11.5px', color: 'faint', mt: '1', fontStyle: 'italic' })}>
          {variable.kind === 'internal'
            ? 'Not a user-facing setting.'
            : 'No description — swisscode does not know what this does.'}
        </div>
      )}
    </div>
  )
}
