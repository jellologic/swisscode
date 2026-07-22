import { useCallback, useEffect, useState } from 'react'
import { css } from '../styled-system/css'
import { ApiError, api, type Bootstrap } from './api'
import { Banner, Dot } from './ui'
import { Profiles } from './routes/Profiles'
import { Providers } from './routes/Providers'
import { Settings } from './routes/Settings'
import { Doctor } from './routes/Doctor'

type Tab = 'profiles' | 'providers' | 'doctor' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'providers', label: 'Providers' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'settings', label: 'Settings' },
]

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
      <main className={css({ maxW: '40rem', mx: 'auto', p: '8' })}>
        <Banner tone="danger">Could not reach swisscode: {error}</Banner>
      </main>
    )
  }
  if (!data) {
    return <main className={css({ p: '8', color: 'faint', fontSize: '13px' })}>loading…</main>
  }

  const installed = data.installedAgents ?? []

  return (
    <div className={css({ display: 'flex', minH: '100vh' })}>
      <aside
        className={css({
          w: '208px',
          flexShrink: 0,
          borderRight: '1px solid',
          borderColor: 'line',
          bg: 'panel',
          p: '3',
          display: 'flex',
          flexDirection: 'column',
        })}
      >
        <div className={css({ px: '2', py: '2', mb: '3' })}>
          <div className={css({ fontSize: '13px', fontWeight: 600, letterSpacing: '-0.01em' })}>
            swisscode
          </div>
          <div className={css({ fontSize: '11px', color: 'faint', mt: '0.5' })}>
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
                fontSize: '13px',
                px: '2',
                height: '30px',
                borderRadius: 'md',
                border: 'none',
                cursor: 'pointer',
                transition: 'background 120ms ease',
                bg: tab === t.id ? 'hover' : 'transparent',
                color: tab === t.id ? 'text' : 'dim',
                _hover: { bg: 'hover', color: 'text' },
              })}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className={css({ mt: 'auto', pt: '4', borderTop: '1px solid', borderColor: 'line' })}>
          <div className={css({ fontSize: '11px', color: 'faint', mb: '2', px: '2' })}>
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
                fontSize: '12px',
                color: a.installed ? 'dim' : 'faint',
              })}
              title={a.path ?? a.error ?? ''}
            >
              <Dot tone={a.installed ? 'ok' : 'faint'} />
              {a.label}
            </div>
          ))}
          <div className={css({ fontSize: '10.5px', color: 'faint', px: '2', mt: '3', fontFamily: 'mono', wordBreak: 'break-all' })}>
            {data.configPath}
          </div>
        </div>
      </aside>

      <main className={css({ flex: 1, p: '6', maxW: '58rem' })}>
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

        {tab === 'profiles' ? <Profiles data={data} reload={reload} /> : null}
        {tab === 'providers' ? <Providers data={data} reload={reload} /> : null}
        {tab === 'doctor' ? <Doctor /> : null}
        {tab === 'settings' ? <Settings data={data} reload={reload} /> : null}
      </main>
    </div>
  )
}
