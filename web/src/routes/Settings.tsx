import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import { Banner, Button, Field, Panel, inputStyle } from '../ui'

export function Settings({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [quiet, setQuiet] = useState(Boolean(data.state.settings.quiet))
  const [depth, setDepth] = useState(String(data.state.settings.bindingWalkDepth ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    setError(null)
    setSaved(false)
    try {
      const settings: Record<string, unknown> = { quiet }
      const n = Number(depth)
      if (depth.trim() && Number.isInteger(n)) settings.bindingWalkDepth = n
      await api.saveSettings(settings, data.revision)
      setSaved(true)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <>
      <h1 className={css({ textStyle: 'heading', fontWeight: 'title', mb: '5' })}>Settings</h1>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel title="Output">
        <label className={css({ display: 'flex', gap: '2', alignItems: 'center', textStyle: 'body' })}>
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          Quiet — suppress warnings and the profile banner
        </label>
        <p className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '2'})}>
          swisscode writes to stderr only; stdout belongs to the agent. A clean environment
          already prints nothing, which is what makes the lines it does print worth reading.
        </p>
      </Panel>

      <Panel title="Directory bindings">
        <Field
          label="Walk depth"
          hint="How far up the tree to look for a binding. Blank uses the default."
        >
          <input className={inputStyle} value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="40" />
        </Field>
      </Panel>

      <div className={css({ display: 'flex', gap: '3', alignItems: 'center' })}>
        <Button variant="primary" onClick={() => void save()}>Save settings</Button>
        {saved ? <span className={css({ textStyle: 'meta', color: 'ok.default' })}>saved</span> : null}
      </div>
    </>
  )
}
