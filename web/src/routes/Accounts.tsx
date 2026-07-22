import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle, monoInput } from '../ui'

/**
 * Provider accounts — who pays.
 *
 * The credential is WRITE-ONLY, and this is the only screen that touches one.
 * The server sends `hasKey` and never the key, so the field offers to replace
 * what is stored: leaving it blank changes nothing, and clearing it is a
 * separate, explicit action. "I did not touch this" and "delete my credential"
 * must not be the same gesture.
 *
 * Deleting shows which profiles the account backs rather than repairing them.
 * Only the user knows which account should pay instead.
 */
export function Accounts({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const accounts = Object.entries(data.state.providerAccounts ?? {})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

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
          <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>
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
        <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>Accounts</h1>
        <Button variant="primary" onClick={() => open(null)}>
          New account
        </Button>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      <Panel title={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}>
        {accounts.length === 0 ? (
          <Empty>No accounts yet. An account is a provider plus the credential that pays for it.</Empty>
        ) : (
          accounts.map(([name, a]) => {
            // The reverse index: a profile lists its accounts, but only this
            // view can say which profiles an account backs — the question you
            // have before deleting one or rotating a key.
            const usedBy = Object.entries(data.state.profiles ?? {})
              .filter(([, p]) => (p.accounts ?? []).includes(name))
              .map(([n]) => n)
            return (
              <div
                key={name}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3',
                  py: '2.5',
                  borderBottom: '1px solid',
                  borderColor: 'line',
                  _last: { borderBottom: 'none' },
                })}
              >
                <Dot tone={a.hasKey || a.apiKeyFromEnv ? 'ok' : 'faint'} />
                <div className={css({ flex: 1, minW: 0 })}>
                  <div className={css({ fontSize: '13px', fontWeight: 500 })}>
                    {name}
                    {a.label ? (
                      <span className={css({ color: 'faint', fontWeight: 400, ml: '2', fontSize: '11.5px' })}>
                        {a.label}
                      </span>
                    ) : null}
                  </div>
                  <div className={css({ fontSize: '11.5px', color: 'faint', fontFamily: 'mono' })}>
                    {a.provider}
                    {' · '}
                    {a.apiKeyFromEnv ? `key from $${a.apiKeyFromEnv}` : a.hasKey ? 'key stored' : 'no key'}
                    {' · '}
                    {usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'unused'}
                  </div>
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
