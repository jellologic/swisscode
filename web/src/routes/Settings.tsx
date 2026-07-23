import { useState } from 'react'
import { css, cx } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import {
  Banner,
  Button,
  Checkbox,
  Code,
  Field,
  FormActions,
  Note,
  PageHeader,
  Panel,
  inputStyle,
} from '../ui'

// A two-digit integer in a 100%-wide box reads as a field somebody forgot to
// finish. `inputStyle` still supplies the box, so this input keeps the same
// height, radius and focus ring as every other control; only the measure moves.
const depthInput = cx(inputStyle, css({ maxW: 'keyColumn' }))

/**
 * The two settings that belong to no profile.
 *
 * It is the smallest screen in the app, so its whole job is saying what these
 * cost: `quiet` decides whether a launch ever speaks, and the walk depth decides
 * how far a binding lookup reaches. Neither is guessable from its name, which is
 * why each carries a line of prose rather than a bare label.
 */
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
      <PageHeader
        title="Settings"
        description="Two switches that belong to no profile: they apply to every launch, whichever profile it resolves."
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel
        title="Output"
        description="swisscode writes to stderr only; stdout belongs to the agent. A clean environment already prints nothing, which is what makes the lines it does print worth reading."
      >
        <Checkbox
          checked={quiet}
          onChange={setQuiet}
          label="Quiet"
          note={
            <>
              Suppresses every line a launch would print — the profile banner, the config and
              selection warnings, and the notice that a newer version is out.{' '}
              <Code>SWISSCODE_QUIET=1</Code> does the same for one shell without saving anything.
            </>
          }
        />
      </Panel>

      <Panel
        title="Directory bindings"
        description="A launch walks up from the working directory to the nearest bound ancestor. The walk is arithmetic on the path — it never touches the filesystem — and it already stops at your shallowest binding, so this is a ceiling rather than a count."
      >
        <Field
          label="Walk depth"
          hint="How many parent directories to look through for a binding. Blank uses the default, 40."
        >
          <input
            className={depthInput}
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            placeholder="40"
          />
        </Field>
      </Panel>

      <FormActions end={saved ? <Note tone="ok">saved</Note> : null}>
        <Button variant="primary" onClick={() => void save()}>
          Save settings
        </Button>
      </FormActions>
    </>
  )
}
