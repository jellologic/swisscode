import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type ClaudeEnvCatalog, type ClaudeEnvKind, type ClaudeEnvVar } from '../api'
import {
  Badge,
  Banner,
  Code,
  CopyButton,
  DataList,
  DataRow,
  Dot,
  Empty,
  Inline,
  Mono,
  PageHeader,
  Panel,
  SearchInput,
  ToggleChip,
  Toolbar,
} from '../ui'
import type { Tone } from '../ui'

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
 *
 * That is also why the classification is carried TWICE and in two registers:
 * once as a legend in the panel header, where each active filter states its
 * caveat in words, and once per row as the leading `Dot` in the same tone. A
 * 495-row list is scanned, not read, and a colour with a legend above it
 * survives scanning where a sentence repeated 338 times does not.
 */

const KIND_COPY: Record<ClaudeEnvKind, { label: string; blurb: ReactNode; tone: Tone }> = {
  documented: {
    label: 'Documented',
    blurb: (
      <>
        Described from Anthropic’s docs, <Code>claude --help</Code>, or swisscode’s own adapter.
        Safe to act on.
      </>
    ),
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
    tone: 'neutral',
  },
}

/** Filter and legend order. Fixed, so the legend cannot reshuffle as filters toggle. */
const KINDS = Object.keys(KIND_COPY) as ClaudeEnvKind[]

const emphasis = css({ color: 'content.primary' })

// The legend renders inside `Panel description`, which is a <p> — a <div> there
// is invalid nesting, so the lines are spans that happen to lay out as a column.
// Keeping it in the panel header rather than above the panel is the point: three
// paragraphs of caveat stacked over a toolbar pushed all 495 rows off the screen.
const legendList = css({ display: 'flex', flexDirection: 'column', gap: '1.5' })
const legendLine = css({ display: 'flex', gap: '2', alignItems: 'baseline' })

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

  const active = KINDS.filter((kind) => kinds.has(kind))

  return (
    <>
      <PageHeader
        title="Environment"
        meta={
          data ? (
            <>
              {data.variables.length} variables · extracted from{' '}
              <Mono>
                {data.source.agent} {data.source.version}
              </Mono>
            </>
          ) : undefined
        }
        description={
          <>
            Every environment variable this Claude Code build references. Set any of them on a
            profile’s <Code>env</Code> block, which is applied last and can override anything the
            provider sets. <strong className={emphasis}>The list is extracted from the binary</strong>
            , so it is complete on names and silent on meaning — which is what the filters below are
            for.
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Toolbar>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="search name or description"
          label="Search environment variables"
        />
        {/*
          Chips, not buttons: these three filters combine, and three filled
          accent buttons in a row would claim the screen has three primary
          actions. The count rides along so the cost of enabling one is visible
          before it is enabled.
        */}
        {KINDS.map((kind) => (
          <ToggleChip
            key={kind}
            pressed={kinds.has(kind)}
            count={counts[kind] ?? 0}
            onClick={() => toggle(kind)}
          >
            {KIND_COPY[kind].label}
          </ToggleChip>
        ))}
      </Toolbar>

      <Panel
        title={`${rows.length} shown`}
        description={
          active.length > 0 ? (
            <span className={legendList}>
              {active.map((kind) => (
                <span key={kind} className={legendLine}>
                  <Badge tone={KIND_COPY[kind].tone}>{KIND_COPY[kind].label}</Badge>
                  <span>{KIND_COPY[kind].blurb}</span>
                </span>
              ))}
            </span>
          ) : undefined
        }
        flush
      >
        {!data && !error ? <Empty>Loading…</Empty> : null}
        {data && rows.length === 0 ? (
          <Empty>Nothing matches. Try a different search, or enable another category above.</Empty>
        ) : null}
        <DataList>
          {rows.map((v) => (
            <Row key={v.name} variable={v} />
          ))}
        </DataList>
      </Panel>
    </>
  )
}

// Why an internal name is internal ("test hook", "unreleased feature codename")
// is a qualifier on the name, not a description of the variable, so it stays on
// the identifier line at `micro` rather than competing with real prose below it.
const rowWhy = css({ textStyle: 'micro', color: 'content.tertiary' })

// A real description gets the readable step: `content.secondary`, measure-limited.
const rowDescription = css({ display: 'block', maxW: 'content', color: 'content.secondary' })

// The absence of one gets the step below, at `micro`. It is the same sentence on
// 338 consecutive rows, and it was previously set in italics — which pulls the
// eye to the one thing on the row that carries no information. The legend in the
// panel header now makes the claim once, in words; this line is the reminder.
const rowUnknown = css({ display: 'block', textStyle: 'micro', color: 'content.tertiary' })

function Row({ variable }: { variable: ClaudeEnvVar }) {
  return (
    <DataRow
      align="start"
      leading={<Dot tone={KIND_COPY[variable.kind].tone} />}
      title={
        <Inline gap="2" align="baseline" wrap>
          <Mono>{variable.name}</Mono>
          {/*
            "swisscode sets this" is the most useful badge on the screen: it tells
            someone the knob is already wired to a profile field, so hand-setting
            it in `env` would fight the launcher rather than configure it. It is
            the only coloured thing on the row besides the classification dot.
          */}
          {variable.managed ? <Badge tone="ok">swisscode sets this</Badge> : null}
          {variable.category ? <Badge>{variable.category}</Badge> : null}
          {variable.kind === 'internal' ? (
            <span className={rowWhy}>{variable.why}</span>
          ) : null}
        </Inline>
      }
      meta={
        variable.description ? (
          <span className={rowDescription}>{variable.description}</span>
        ) : (
          /*
            An explicit blank, not an empty cell. The absence is the finding: we
            know the name exists and we do not know what it does, and saying so is
            the honest version of a catalog built by reading a binary.
          */
          <span className={rowUnknown}>
            {variable.kind === 'internal'
              ? 'Not a user-facing setting.'
              : 'No description — swisscode does not know what this does.'}
          </span>
        )
      }
      actions={<CopyButton value={variable.name} />}
    />
  )
}
