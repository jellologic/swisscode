import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type DoctorReport } from '../api'
import { Banner, Button, Dot, Empty, Panel } from '../ui'
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
 * The doctor, on demand.
 *
 * Offline is the default and the network run is a separate, clearly-labelled
 * button: the probes are real inference requests, and a UI that spends money on
 * a click nobody understood would be a worse bug than anything it diagnoses.
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
      <h1 className={css({ textStyle: 'heading', fontWeight: 'title', mb: '5' })}>Doctor</h1>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel
        title="Run checks"
        action={
          <span className={css({ display: 'flex', gap: '2' })}>
            <Button onClick={() => void run(true)} disabled={busy}>
              {busy ? 'Running…' : 'Check offline'}
            </Button>
            <Button variant="primary" onClick={() => void run(false)} disabled={busy}>
              Check with live probes
            </Button>
          </span>
        }
      >
        <p className={css({ textStyle: 'meta', color: 'content.tertiary'})}>
          Offline checks read your config, resolve the agent binary and inspect the environment.
          Live probes additionally send a real request to the endpoint — at most one per distinct
          model plus one tool-calling probe — which your provider will bill you for.
        </p>
      </Panel>

      {report ? (
        <Panel
          title={`${report.profile ?? 'no profile'} · ${report.provider ?? '—'}${probed ? ' · probed' : ' · offline'}`}
        >
          {report.checks.length === 0 ? (
            <Empty>No checks ran.</Empty>
          ) : (
            report.checks.map((c) => (
              <div
                key={c.id}
                className={css({
                  display: 'flex',
                  gap: '3',
                  alignItems: 'flex-start',
                  py: '2',
                  borderBottom: '[1px solid]',
                  borderColor: 'border.subtle',
                  _last: { borderBottom: 'none' },
                })}
              >
                <span className={css({ mt: '1.5' })}>
                  <Dot tone={TONE[c.status]} />
                </span>
                <div className={css({ flex: '1', minW: '0' })}>
                  <div className={css({ textStyle: 'meta', fontWeight: 'medium' })}>{c.title}</div>
                  <div className={css({ textStyle: 'meta', color: 'content.secondary'})}>
                    {c.detail}
                  </div>
                  {c.fix ? (
                    <div className={css({ textStyle: 'meta', color: 'warn.default', mt: '1' })}>
                      ↳ {c.fix}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {report.notes.map((n) => (
            <p key={n} className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '3'})}>
              {n}
            </p>
          ))}
        </Panel>
      ) : null}
    </>
  )
}
