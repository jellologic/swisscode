import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type DoctorReport } from '../api'
import { Banner, Button, Dot, Empty, Panel } from '../ui'

const TONE = { ok: 'ok', warn: 'warn', error: 'danger', skip: 'faint' } as const

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
      <h1 className={css({ fontSize: '15px', fontWeight: 600, mb: '5' })}>Doctor</h1>
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
        <p className={css({ fontSize: '12px', color: 'faint', lineHeight: 1.6 })}>
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
                  borderBottom: '1px solid',
                  borderColor: 'line',
                  _last: { borderBottom: 'none' },
                })}
              >
                <span className={css({ mt: '1.5' })}>
                  <Dot tone={TONE[c.status]} />
                </span>
                <div className={css({ flex: 1, minW: 0 })}>
                  <div className={css({ fontSize: '12.5px', fontWeight: 500 })}>{c.title}</div>
                  <div className={css({ fontSize: '12px', color: 'dim', lineHeight: 1.55 })}>
                    {c.detail}
                  </div>
                  {c.fix ? (
                    <div className={css({ fontSize: '11.5px', color: 'warn', mt: '1' })}>
                      ↳ {c.fix}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {report.notes.map((n) => (
            <p key={n} className={css({ fontSize: '11.5px', color: 'faint', mt: '3', lineHeight: 1.55 })}>
              {n}
            </p>
          ))}
        </Panel>
      ) : null}
    </>
  )
}
