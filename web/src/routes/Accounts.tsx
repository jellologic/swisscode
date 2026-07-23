import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap, type ProviderAccount, type UsageReport } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle, monoInput } from '../ui'
// The SAME decisions the CLI and the API make, imported rather than restated.
// core/ is pure — no I/O, no node builtins — so it bundles into the browser as
// happily as it compiles for the launch path.
import { accountsUsedBy, credentialSource } from '../../../src/core/account'
import { formatWindow } from '../../../src/core/format'

/**
 * Provider accounts — who pays.
 *
 * An account authenticates one of two ways, and they are mutually exclusive:
 *
 *   key      an API key, WRITE-ONLY. The server sends `hasKey` and never the
 *            key, so the field offers to REPLACE what is stored: leaving it
 *            blank changes nothing, and clearing it is a separate, explicit
 *            action. "I did not touch this" and "delete my credential" must not
 *            be the same gesture.
 *   session  a directory holding a login the agent already performed. The path
 *            crosses to this page in full because it is not a secret — the
 *            credential stays in the OS keychain, which is the whole point.
 *
 * Deleting shows which profiles the account backs rather than repairing them.
 * Only the user knows which account should pay instead.
 */
/**
 * Is this account ready to launch? The DECISION is core's; only the question is
 * asked here.
 *
 * A session account is ready when someone has LOGGED IN, not when a path is
 * set: a directory nobody has logged into is indistinguishable in config.json
 * from one that works, and fails only after execve.
 */
function ready(account: ProviderAccount, login: string | null): boolean {
  switch (credentialSource(account)) {
    case 'session':
      return Boolean(login)
    case 'key':
    case 'key-from-env':
      return true
    default:
      return false
  }
}

/** The one-line credential summary, in the browser's own words. */
function credentialLine(account: ProviderAccount, login: string | null): string {
  switch (credentialSource(account)) {
    case 'session':
      return login ?? 'not logged in'
    case 'key-from-env':
      return `key from $${account.apiKeyFromEnv}`
    case 'key':
      return 'key stored'
    case 'conflict':
      return 'both a key and a login — the launch ignores the key'
    default:
      return 'no key'
  }
}

export function Accounts({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const accounts = Object.entries(data.state.providerAccounts ?? {})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [measuring, setMeasuring] = useState(false)

  const measure = async () => {
    setError(null)
    setMeasuring(true)
    try {
      setUsage(await api.usage())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setMeasuring(false)
    }
  }

  const open = (name: string | null) => {
    setError(null)
    setWarnings([])
    setEditing(name ?? '')
    setDraft(
      name
        ? { ...data.state.providerAccounts[name], apiKey: '' }
        : { provider: data.providers[0]?.id ?? 'anthropic', apiKey: '' },
    )
  }

  const save = async (name: string) => {
    setError(null)
    try {
      const body: Record<string, unknown> = { ...draft }
      // An empty string means "untouched", so it never leaves the browser. The
      // server ignores it anyway; not sending it makes the intent explicit at
      // the boundary that owns it.
      if (!body.apiKey) delete body.apiKey
      delete body.hasKey
      // Switching an account to session mode must CLEAR the key it used to
      // carry, not leave it stored behind the new one. The server refuses an
      // account holding both — correctly, since "which credential did this
      // actually use" must never have a subtle answer — so the explicit null
      // is what makes the switch expressible at all.
      if (body.configDir) {
        body.apiKey = null
        body.apiKeyFromEnv = ''
      }
      await api.saveAccount(name, body, data.revision)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const remove = async (name: string) => {
    setError(null)
    try {
      const res = await api.deleteAccount(name, data.revision)
      if (res.affectedProfiles.length > 0) {
        setWarnings([
          `These profiles still reference "${name}" and will not launch until you repoint ` +
            `them: ${res.affectedProfiles.join(', ')}`,
        ])
      }
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const field = (k: string) => (draft[k] as string) ?? ''
  const put = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))

  if (editing !== null) {
    const isNew = !data.state.providerAccounts?.[editing]
    const provider = data.providers.find((p) => p.id === draft.provider)
    const stored = data.state.providerAccounts?.[editing]
    return (
      <>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3', mb: '5' })}>
          <Button onClick={() => setEditing(null)}>← Back</Button>
          <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>
            {isNew ? 'New account' : `Account · ${editing}`}
          </h1>
        </div>
        {error ? <Banner tone="danger">{error}</Banner> : null}

        <Panel title="Identity">
          {isNew ? (
            <Field label="Name" hint="How profiles refer to this account.">
              <input
                className={inputStyle}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="work"
              />
            </Field>
          ) : null}
          <Field label="Label" hint="Optional, for your own benefit.">
            <input className={inputStyle} value={field('label')} onChange={(e) => put('label', e.target.value)} />
          </Field>
          <Field label="Provider">
            <select
              className={inputStyle}
              value={String(draft.provider ?? '')}
              onChange={(e) => put('provider', e.target.value)}
            >
              {data.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {data.reservedProviderIds.includes(p.id) ? '' : '  (custom)'}
                </option>
              ))}
            </select>
          </Field>
          {provider?.askBaseUrl || draft.baseUrl ? (
            <Field
              label="Base URL"
              hint="Anthropic-compatible route. No /v1 — that is the OpenAI one."
            >
              <input
                className={monoInput}
                value={field('baseUrl')}
                onChange={(e) => put('baseUrl', e.target.value)}
                placeholder={provider?.baseUrl ?? 'https://…'}
              />
            </Field>
          ) : null}
        </Panel>

        <Panel title="Credential">
          <Field
            label="How this account authenticates"
            hint="A key, or a login the agent already performed. Never both — the server refuses that rather than picking one."
          >
            <select
              className={inputStyle}
              value={draft.configDir ? 'session' : 'key'}
              onChange={(e) => put('configDir', e.target.value === 'session' ? '~/.claude' : '')}
            >
              <option value="key">API key</option>
              <option value="session">Existing Claude Code login</option>
            </select>
          </Field>

          {draft.configDir ? (
            <>
              <Field
                label="Session directory"
                hint="The CLAUDE_CONFIG_DIR this account launches with. ~/.claude is the login you already have; a separate path is a separate account."
              >
                <input
                  className={monoInput}
                  value={field('configDir')}
                  onChange={(e) => put('configDir', e.target.value)}
                  placeholder="~/.claude"
                />
              </Field>
              {/*
                THE ONE THING THIS PAGE CANNOT DO. `/login` is an interactive
                OAuth flow inside the agent's own TUI; a browser tab cannot
                drive it. Pointing an account at an empty directory here is
                legal and silently useless until someone logs in there, so the
                terminal command that does it is named rather than implied.
              */}
              <Banner tone="warn">
                Logging in happens in a terminal, not here — run{' '}
                <code>swisscode config accounts login {editing || '<name>'}</code> and complete{' '}
                <code>/login</code> inside the agent. This page only points the account at a
                directory.
              </Banner>
              {!isNew && data.logins ? (
                <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono' })}>
                  currently: {data.logins[editing] ?? 'not logged in'}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <Field
                label={stored?.hasKey ? 'Replace stored key' : 'API key'}
                hint={
                  provider?.hints.keyHint ??
                  'Write-only: the key is never sent to this page. Leave blank to keep the stored one.'
                }
              >
                <input
                  className={monoInput}
                  type="password"
                  value={field('apiKey')}
                  onChange={(e) => put('apiKey', e.target.value)}
                  placeholder={stored?.hasKey ? '•••••••• stored' : 'paste key'}
                />
              </Field>
              <Field
                label="…or read it from an environment variable"
                hint="Keeps the secret out of config.json entirely."
              >
                <input
                  className={monoInput}
                  value={field('apiKeyFromEnv')}
                  onChange={(e) => put('apiKeyFromEnv', e.target.value)}
                  placeholder="MY_TOKEN"
                />
              </Field>
            </>
          )}
        </Panel>

        <div className={css({ display: 'flex', gap: '2', mb: '10' })}>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create account' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: '5' })}>
        <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>Accounts</h1>
        <div className={css({ display: 'flex', gap: '2' })}>
          {/*
            Measuring is a BUTTON rather than something the page does on load.
            Each session account costs a keychain read — which on macOS can pop
            an unlock dialog — plus a request to Anthropic. A screen that did
            that every time you opened it would be indefensible.
          */}
          <Button onClick={() => void measure()} disabled={measuring}>
            {measuring ? 'Measuring…' : 'Measure usage'}
          </Button>
          <Button variant="primary" onClick={() => open(null)}>
            New account
          </Button>
        </div>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
      {usage?.checkedAt === null ? (
        <Banner tone="warn">
          Nothing could be measured, so the cached figures were left alone. An account must be logged
          in, and its token unexpired, to report a window.
        </Banner>
      ) : null}
      {usage?.checkedAt ? (
        <div className={css({ textStyle: 'meta', color: 'content.tertiary', mb: '4'})}>
          Measured {new Date(usage.checkedAt).toLocaleTimeString()}. “% left” is the tighter of the two
          windows, never their average — an account at 5% of its 5-hour window and 95% of its weekly
          one has almost nothing left. Profiles using the <code>usage</code> strategy now select on
          these figures.
        </div>
      ) : null}

      <Panel title={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}>
        {accounts.length === 0 ? (
          <Empty>No accounts yet. An account is a provider plus the credential that pays for it.</Empty>
        ) : (
          accounts.map(([name, a]) => {
            // The reverse index: a profile lists its accounts, but only this
            // view can say which profiles an account backs — the question you
            // have before deleting one or rotating a key.
            const usedBy = accountsUsedBy(data.state.profiles, name)
            const login = a.configDir ? (data.logins?.[name] ?? null) : null
            const measured = usage?.accounts.find((m) => m.name === name)
            return (
              <div
                key={name}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3',
                  py: '2.5',
                  borderBottom: '[1px solid]',
                  borderColor: 'border.subtle',
                  _last: { borderBottom: 'none' },
                })}
              >
                {/*
                  A session account is "ready" when someone has LOGGED IN there,
                  not when a path is set. A directory nobody has logged into
                  looks identical in config.json and fails only after execve, so
                  the dot tracks the login rather than the field.
                */}
                <Dot tone={ready(a, login) ? 'ok' : 'neutral'} />
                <div className={css({ flex: '1', minW: '0' })}>
                  <div className={css({ textStyle: 'body', fontWeight: 'medium' })}>
                    {name}
                    {a.label ? (
                      <span className={css({ color: 'content.tertiary', fontWeight: 'normal', ml: '2', textStyle: 'meta' })}>
                        {a.label}
                      </span>
                    ) : null}
                  </div>
                  <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono' })}>
                    {a.provider}
                    {' · '}
                    {credentialLine(a, login)}
                    {' · '}
                    {usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'unused'}
                  </div>
                  {measured ? (
                    <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono', mt: '1' })}>
                      {measured.mode === 'key'
                        ? 'key account — no subscription window'
                        : measured.remaining === null
                          ? 'could not be measured'
                          : `${measured.remaining}% left · 5h ${formatWindow(measured.fiveHour)} · 7d ${formatWindow(measured.sevenDay)}`}
                    </div>
                  ) : null}
                </div>
                <Button onClick={() => open(name)}>Edit</Button>
                <Button variant="danger" onClick={() => void remove(name)}>
                  Delete
                </Button>
              </div>
            )
          })
        )}
      </Panel>
    </>
  )
}
