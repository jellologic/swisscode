import { useState } from 'react'
import { css, cva } from '../../styled-system/css'
import { ApiError, api, type DoctorCheck, type DoctorReport } from '../api'
import {
  Badge,
  Banner,
  Button,
  DataList,
  DataRow,
  Dot,
  Empty,
  Inline,
  Note,
  PageHeader,
  Panel,
  Stack,
} from '../ui'
import type { Tone } from '../ui'

// `satisfies` rather than a bare `as const`: it pins the map to the Tone union,
// so a status that gains a tone with no matching colour fails here rather than
// rendering an invisible dot.
const TONE = {
  ok: 'ok',
  warn: 'warn',
  error: 'danger',
  skip: 'neutral',
} as const satisfies Record<string, Tone>

/**
 * The advice line under a failing check.
 *
 * Built here rather than in `ui.tsx` because nothing else in the app has an
 * "and here is what to type" block, and a primitive with one caller is not a
 * primitive. A `cva` rather than `css({ borderColor: TONE[status] })` for the
 * reason the whole codebase uses recipes for status colour: Panda extracts
 * literals at build time, so a colour it can only learn at runtime emits no CSS.
 *
 * It owns its own `mt` — the exception the spacing rule allows nowhere else —
 * because it renders in `DataRow`'s children slot, below `meta`, and a `Stack`
 * cannot put a gap between two slots of a component it does not wrap.
 */
const fixBlock = cva({
  base: {
    mt: '2',
    textStyle: 'meta',
    color: 'content.secondary',
    bg: 'surface.raised',
    borderRadius: 'xs',
    // WIDTH AND STYLE ONLY. `borderLeft: '[2px solid]'` is a shorthand with no
    // colour in it, which resets `border-left-color` to `currentColor` whenever
    // Panda emits it after the variant's `borderColor` — and it did, for four of
    // these five tones. The rule beside every FAILED check drew in the text
    // colour; only `ok`, the tone used for checks that need no attention,
    // happened to land after it and render. Longhands reset nothing.
    borderInlineStartWidth: 'marker',
    borderInlineStartStyle: 'solid',
    px: '2.5',
    py: '1.5',
    maxW: 'content',
  },
  variants: {
    tone: {
      ok: { borderColor: 'ok.default' },
      warn: { borderColor: 'warn.default' },
      danger: { borderColor: 'danger.default' },
      accent: { borderColor: 'accent.default' },
      neutral: { borderColor: 'border.strong' },
    },
  },
  defaultVariants: { tone: 'neutral' },
})

// A passed check is one line, and both halves of it sit below the weight of a
// title that needs reading: the panel it is in already says it passed.
const quietTitle = css({ fontWeight: 'normal', color: 'content.secondary' })
const quietDetail = css({ textStyle: 'meta', color: 'content.tertiary' })
const countLabel = css({ textStyle: 'meta', color: 'content.tertiary' })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A check that failed: status word, detail, and the fix set apart from both. */
function FailedCheck({ check }: { check: DoctorCheck }) {
  const tone = TONE[check.status]
  return (
    <DataRow
      align="start"
      leading={<Dot tone={tone} />}
      title={
        <Inline gap="2" align="baseline" wrap>
          <span>{check.title}</span>
          <Badge tone={tone}>{check.status}</Badge>
        </Inline>
      }
      meta={check.detail}
    >
      {check.fix ? <p className={fixBlock({ tone })}>↳ {check.fix}</p> : null}
    </DataRow>
  )
}

/** A check that passed or never ran. Title and detail share one line, quietly. */
function QuietCheck({ check }: { check: DoctorCheck }) {
  const tone = TONE[check.status]
  return (
    <DataRow
      align={check.fix ? 'start' : 'center'}
      leading={<Dot tone={tone} />}
      title={
        <Inline gap="2" align="baseline" wrap>
          <span className={quietTitle}>{check.title}</span>
          <span className={quietDetail}>{check.detail}</span>
        </Inline>
      }
    >
      {check.fix ? <p className={fixBlock({ tone })}>↳ {check.fix}</p> : null}
    </DataRow>
  )
}

/**
 * The report, split by severity.
 *
 * One list of twenty rows at one weight is a list nobody reads: the two
 * findings that are the entire reason to run the doctor sit somewhere in the
 * middle of eighteen that need nothing. Grouping puts them first and lets the
 * passes recede to a line each.
 *
 * `skip` gets its own group rather than being folded in with the passes, for
 * the same reason the port keeps it a distinct status: a check that did not run
 * is not a check that succeeded, and filing it under "Passed" would report all
 * clear for work nobody did.
 *
 * WITHIN a group the doctor's own order survives, because `filter` is stable —
 * that is the part worth not losing. The three groups reorder the report
 * relative to what the CLI prints, on purpose; the checks inside one never do,
 * so a row's neighbours are still the rows the doctor put next to it.
 */
function Report({ report }: { report: DoctorReport }) {
  const failed = report.checks.filter((c) => c.status === 'error' || c.status === 'warn')
  const passed = report.checks.filter((c) => c.status === 'ok')
  const skipped = report.checks.filter((c) => c.status === 'skip')
  const errors = failed.filter((c) => c.status === 'error').length
  const warnings = failed.length - errors

  return (
    <>
      {report.checks.length === 0 ? (
        <Panel title="Checks" flush>
          <Empty>No checks ran.</Empty>
        </Panel>
      ) : null}

      {failed.length > 0 ? (
        <Panel
          title="Needs attention"
          action={
            <Inline gap="1.5">
              {errors > 0 ? <Badge tone="danger">{plural(errors, 'error')}</Badge> : null}
              {warnings > 0 ? <Badge tone="warn">{plural(warnings, 'warning')}</Badge> : null}
            </Inline>
          }
          flush
        >
          <DataList>
            {failed.map((c) => (
              <FailedCheck key={c.id} check={c} />
            ))}
          </DataList>
        </Panel>
      ) : null}

      {passed.length > 0 ? (
        <Panel title="Passed" action={<span className={countLabel}>{passed.length}</span>} flush>
          <DataList>
            {passed.map((c) => (
              <QuietCheck key={c.id} check={c} />
            ))}
          </DataList>
        </Panel>
      ) : null}

      {skipped.length > 0 ? (
        <Panel title="Not run" action={<span className={countLabel}>{skipped.length}</span>} flush>
          <DataList>
            {skipped.map((c) => (
              <QuietCheck key={c.id} check={c} />
            ))}
          </DataList>
        </Panel>
      ) : null}

      {report.notes.length > 0 ? (
        <Panel title="Notes">
          <Stack gap="2">
            {report.notes.map((n) => (
              <Note key={n}>{n}</Note>
            ))}
          </Stack>
        </Panel>
      ) : null}
    </>
  )
}

/**
 * The doctor, on demand.
 *
 * Offline is the default and the network run is a separate, clearly-labelled
 * button: the probes are real inference requests, and a UI that spends money on
 * a click nobody understood would be a worse bug than anything it diagnoses.
 * Which is why the sentence about being billed sits in the same row as the
 * button that does the billing, where it is read at the moment of the click
 * rather than in a caption above both runs — and why the filled accent is on
 * the free run. The screen's one call to action must not be the one that costs.
 */
export function Doctor() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probed, setProbed] = useState(false)

  const run = async (offline: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.doctor(offline)
      setReport(res.report)
      setProbed(!res.offline)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Doctor"
        meta={
          report
            ? `${report.profile ?? 'no profile'} · ${report.provider ?? '—'}${probed ? ' · probed' : ' · offline'}`
            : undefined
        }
        description="Everything that has to be true before a launch works — your config, the agent binary, the environment, and, only if you ask for it, the endpoint itself."
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel title="Run checks" flush>
        <DataList>
          <DataRow
            align="start"
            title="Offline"
            meta="Offline checks read your config, resolve the agent binary and inspect the environment."
            actions={
              <Button variant="primary" onClick={() => void run(true)} disabled={busy}>
                {busy ? 'Running…' : 'Check offline'}
              </Button>
            }
          />
          <DataRow
            align="start"
            title={
              <Inline gap="2" align="baseline" wrap>
                <span>Live probes</span>
                <Badge tone="warn">billable</Badge>
              </Inline>
            }
            meta="Live probes additionally send a real request to the endpoint — at most one per distinct model plus one tool-calling probe — which your provider will bill you for."
            actions={
              <Button onClick={() => void run(false)} disabled={busy}>
                Check with live probes
              </Button>
            }
          />
        </DataList>
      </Panel>

      {report ? <Report report={report} /> : null}
    </>
  )
}
