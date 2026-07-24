import { useCallback, useEffect, useState } from 'react'
import { css, cx } from '../styled-system/css'
import {
  applyTheme,
  readPreference,
  resolveTheme,
  writePreference,
  type ThemePreference,
} from './theme'
import { ApiError, api, type Bootstrap } from './api'
import { BrandMark } from './Brand'
import { Banner, Dot, SegmentedControl } from './ui'
import { Profiles } from './routes/Profiles'
import { Accounts } from './routes/Accounts'
import { AgentProfiles } from './routes/AgentProfiles'
import { Providers } from './routes/Providers'
import { Settings } from './routes/Settings'
import { Doctor } from './routes/Doctor'
import { Environment } from './routes/Environment'

type Tab = 'profiles' | 'accounts' | 'agentProfiles' | 'providers' | 'environment' | 'doctor' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  // Ordered as the concepts compose: who pays, what runs, then the pairing.
  { id: 'accounts', label: 'Accounts' },
  { id: 'agentProfiles', label: 'Agent profiles' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'providers', label: 'Providers' },
  { id: 'environment', label: 'Environment' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'settings', label: 'Settings' },
]

// The two captions in the sidebar's footer. One class, because they are one
// thing: the label over a group, a step quieter than the `SectionLabel` a panel
// uses because the sidebar is chrome and must not compete with the page.
const sidebarLabel = css({ textStyle: 'micro', color: 'content.tertiary', px: '2' })

// Module scope, like `TABS`: a constant list rebuilt on every render is a new
// array each time for no reason.
const THEME_OPTIONS: readonly { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

/** Ties the sidebar's visible "Theme" caption to the group it names. */
const THEME_LABEL_ID = 'theme-preference'

/**
 * Light, dark, or follow the machine.
 *
 * `system` is the DEFAULT AND A REAL CHOICE, not the absence of one — picking
 * light at noon should not mean the app ignores the machine switching to dark
 * at sunset. The live listener below is what makes that true: while the
 * preference is `system`, the OS changing re-resolves immediately, with no
 * reload.
 *
 * The control is `SegmentedControl size="sm"`, which is what that variant was
 * added for — three mutually exclusive views, the chosen one raised out of the
 * track rather than tinted. This screen used to hand-roll it, down to the same
 * `surface.hover` track, the same `0.5` padding and the same radii, which is the
 * form the drift takes: not a component someone decided to vary, just one nobody
 * noticed already existed.
 */
function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(() => readPreference())

  useEffect(() => {
    applyTheme(resolveTheme(preference))
    writePreference(preference)
    if (preference !== 'system') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(resolveTheme('system'))
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  return (
    <div className={css({ mb: '3' })}>
      {/* Named by the caption above it rather than by a second copy of the word. */}
      <div id={THEME_LABEL_ID} className={cx(sidebarLabel, css({ mb: '1.5' }))}>
        Theme
      </div>
      <div className={css({ px: '2' })}>
        <SegmentedControl
          labelledBy={THEME_LABEL_ID}
          size="sm"
          stretch
          options={THEME_OPTIONS}
          value={preference}
          onChange={setPreference}
        />
      </div>
    </div>
  )
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('profiles')

  const reload = useCallback(async () => {
    try {
      setData(await api.bootstrap())
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) {
    return (
      <main className={css({ maxW: 'content', mx: 'auto', p: '8' })}>
        <Banner tone="danger">Could not reach swisscode: {error}</Banner>
      </main>
    )
  }
  if (!data) {
    return <main className={css({ p: '8', color: 'content.tertiary', textStyle: 'body' })}>loading…</main>
  }

  const installed = data.installedAgents ?? []

  return (
    <div className={css({ display: 'flex', minH: '[100vh]' })}>
      <aside
        className={css({
          w: 'sidebar',
          flexShrink: 0,
          borderRight: 'hairline',
          bg: 'surface.panel',
          p: '3',
          display: 'flex',
          flexDirection: 'column',
        })}
      >
        <div className={css({ px: '2', py: '2', mb: '3' })}>
          <BrandMark subtitle="local configuration" />
        </div>

        <nav className={css({ display: 'flex', flexDirection: 'column', gap: '0.5' })}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={css({
                textAlign: 'left',
                font: 'inherit',
                textStyle: 'body',
                px: '2',
                height: 'control',
                borderRadius: 'md',
                border: 'none',
                cursor: 'pointer',
                transitionProperty: 'colors',
                // Paired with the property, always. A `transition-property` with
                // no duration defaults to 0s, so the hover it names never runs —
                // every other control in the app sets both.
                transitionDuration: 'fast',
                bg: tab === t.id ? 'surface.hover' : 'transparent',
                color: tab === t.id ? 'content.primary' : 'content.secondary',
                _hover: { bg: 'surface.hover', color: 'content.primary' },
              })}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className={css({ mt: 'auto', pt: '4', borderTop: 'hairline' })}>
          <ThemeControl />
          <div className={cx(sidebarLabel, css({ mb: '2' }))}>Agents on this machine</div>
          {installed.map((a) => (
            <div
              key={a.id}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '2',
                px: '2',
                py: '1',
                textStyle: 'meta',
                color: a.installed ? 'content.secondary' : 'content.tertiary',
              })}
              title={a.path ?? a.error ?? ''}
            >
              <Dot tone={a.installed ? 'ok' : 'neutral'} />
              {a.label}
            </div>
          ))}
          {/*
            `textStyle: 'code'` rather than `micro` + `fontFamily: 'mono'`, which
            is the one construct the type scale forbids: a size and a family set
            independently is how a second, undeclared mono treatment appears. The
            path stays tertiary, so it still reads as the footnote it is.
          */}
          <div className={css({ textStyle: 'code', color: 'content.tertiary', px: '2', mt: '3', wordBreak: 'break-all' })}>
            {data.configPath}
          </div>
        </div>
      </aside>

      {/*
        `minW: '0'` is load-bearing, not defensive. A flex item defaults to
        `min-width: auto`, so it cannot shrink below its content's min-content
        width — and the Profiles screen's widest row pushed <main> 164px past
        the shell at a 700px viewport, giving the whole DOCUMENT a horizontal
        scrollbar. Every other screen fitted, which is what made it look like a
        Profiles bug rather than a shell one.
      */}
      <main className={css({ flex: '1', minW: '0', p: '6', maxW: 'main' })}>
        {data.readOnly ? (
          <Banner tone="warn">
            config.json is a newer schema than this swisscode understands. Every write is
            disabled so an older build cannot clobber a newer file.
          </Banner>
        ) : null}
        {data.warnings.map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}

        {tab === 'accounts' ? <Accounts data={data} reload={reload} /> : null}
        {tab === 'agentProfiles' ? <AgentProfiles data={data} reload={reload} /> : null}
        {tab === 'profiles' ? <Profiles data={data} reload={reload} /> : null}
        {tab === 'providers' ? <Providers data={data} reload={reload} /> : null}
        {tab === 'environment' ? <Environment /> : null}
        {tab === 'doctor' ? <Doctor /> : null}
        {tab === 'settings' ? <Settings data={data} reload={reload} /> : null}
      </main>
    </div>
  )
}
