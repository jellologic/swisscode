import { useCallback, useEffect, useState } from 'react'
import { css } from '../styled-system/css'
import {
  applyTheme,
  readPreference,
  resolveTheme,
  writePreference,
  type ThemePreference,
} from './theme'
import { ApiError, api, type Bootstrap } from './api'
import { Banner, Dot } from './ui'
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

/**
 * Light, dark, or follow the machine.
 *
 * `system` is the DEFAULT AND A REAL CHOICE, not the absence of one — picking
 * light at noon should not mean the app ignores the machine switching to dark
 * at sunset. The live listener below is what makes that true: while the
 * preference is `system`, the OS changing re-resolves immediately, with no
 * reload.
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

  const OPTIONS: readonly { id: ThemePreference; label: string }[] = [
    { id: 'system', label: 'Auto' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ]

  return (
    <div className={css({ px: '2', mb: '3' })}>
      <div className={css({ textStyle: 'micro', color: 'content.tertiary', mb: '1.5' })}>Theme</div>
      <div
        className={css({
          display: 'flex',
          bg: 'surface.hover',
          borderRadius: 'sm',
          p: '0.5',
          gap: '0.5',
        })}
      >
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => setPreference(o.id)}
            aria-pressed={preference === o.id}
            className={css({
              flex: '1',
              textStyle: 'micro',
              py: '1',
              borderRadius: 'xs',
              border: 'none',
              cursor: 'pointer',
              transitionProperty: 'colors',
              transitionDuration: 'fast',
              bg: preference === o.id ? 'surface.panel' : 'transparent',
              color: preference === o.id ? 'content.primary' : 'content.tertiary',
              _hover: { color: 'content.primary' },
            })}
          >
            {o.label}
          </button>
        ))}
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
      <main className={css({ maxW: '[40rem]', mx: 'auto', p: '8' })}>
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
          borderRight: '[1px solid]',
          borderColor: 'border.subtle',
          bg: 'surface.panel',
          p: '3',
          display: 'flex',
          flexDirection: 'column',
        })}
      >
        <div className={css({ px: '2', py: '2', mb: '3' })}>
          <div className={css({ textStyle: 'body', fontWeight: 'title' })}>
            swisscode
          </div>
          <div className={css({ textStyle: 'micro', color: 'content.tertiary', mt: '0.5' })}>
            local configuration
          </div>
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
                bg: tab === t.id ? 'surface.hover' : 'transparent',
                color: tab === t.id ? 'content.primary' : 'content.secondary',
                _hover: { bg: 'surface.hover', color: 'content.primary' },
              })}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className={css({ mt: 'auto', pt: '4', borderTop: '[1px solid]', borderColor: 'border.subtle' })}>
          <ThemeControl />
          <div className={css({ textStyle: 'micro', color: 'content.tertiary', mb: '2', px: '2' })}>
            Agents on this machine
          </div>
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
          <div className={css({ textStyle: 'micro', color: 'content.tertiary', px: '2', mt: '3', fontFamily: 'mono', wordBreak: 'break-all' })}>
            {data.configPath}
          </div>
        </div>
      </aside>

      <main className={css({ flex: '1', p: '6', maxW: '[58rem]' })}>
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
