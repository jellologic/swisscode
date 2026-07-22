import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap, type Profile } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle, monoInput } from '../ui'

/**
 * The profile editor exposes everything the CLI can express: provider, agent,
 * all four tiers, permissions, compat flags, extra environment, and the
 * measured context windows that drive auto-compaction.
 *
 * The credential is WRITE-ONLY. The server sends `hasKey` and never the key, so
 * the field shows whether one is stored and offers to replace it — leaving it
 * blank changes nothing, which is why "I did not touch this" and "delete my
 * credential" are different actions here.
 */
export function Profiles({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const names = Object.keys(data.state.profiles)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const open = (name: string | null) => {
    setError(null)
    setErrors([])
    setEditing(name ?? '')
    const existing = name ? data.state.profiles[name] : undefined
    setDraft(
      existing
        ? { ...existing, apiKey: '' }
        : { provider: data.providers[0]?.id ?? 'anthropic', models: {}, compat: {}, apiKey: '' },
    )
  }

  const save = async (name: string) => {
    setError(null)
    setErrors([])
    try {
      const body: Record<string, unknown> = { ...draft }
      // An empty string means "untouched", so it is removed rather than sent —
      // the server would ignore it, but not sending it is what makes that
      // intent explicit at the boundary that owns it.
      if (!body.apiKey) delete body.apiKey
      delete body.hasKey
      await api.saveProfile(name, body, data.revision)
      setEditing(null)
      await reload()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setErrors(err.errors)
      } else setError(String(err))
    }
  }

  const remove = async (name: string) => {
    setError(null)
    try {
      await api.deleteProfile(name, data.revision)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const setDefault = async (name: string) => {
    try {
      await api.setDefault(name, data.revision)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const field = (key: string) => (draft[key] as string) ?? ''
  const put = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }))
  const models = (draft.models as Record<string, string>) ?? {}
  const compat = (draft.compat as Record<string, boolean>) ?? {}

  if (editing !== null) {
    const isNew = !names.includes(editing)
    const provider = data.providers.find((p) => p.id === draft.provider)
    return (
      <>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3', mb: '5' })}>
          <Button onClick={() => setEditing(null)}>← Back</Button>
          <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>
            {isNew ? 'New profile' : `Profile · ${editing}`}
          </h1>
        </div>

        {error ? (
          <Banner tone="danger">
            {error}
            {errors.length > 1 ? (
              <ul className={css({ mt: '1.5', pl: '4' })}>
                {errors.slice(1).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}

        <Panel title="Identity">
          {isNew ? (
            <Field
              label="Name"
              hint="Used as `swisscode <name>`. Reserved words and likely prompt-openers are refused."
            >
              <input
                className={inputStyle}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="work"
              />
            </Field>
          ) : null}

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

          <Field
            label="Agent"
            hint="Which coding CLI to launch. Blank uses Claude Code."
          >
            <select
              className={inputStyle}
              value={String(draft.agent ?? '')}
              onChange={(e) => put('agent', e.target.value)}
            >
              <option value="">Claude Code (default)</option>
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {data.installedAgents?.find((i) => i.id === a.id)?.installed === false
                    ? '  — not installed'
                    : ''}
                </option>
              ))}
            </select>
          </Field>

          {provider?.askBaseUrl || draft.baseUrl ? (
            <Field label="Base URL" hint="Anthropic-compatible endpoint. No /v1 — that is the OpenAI route.">
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
            label={
              (data.state.profiles[editing]?.hasKey ?? false)
                ? 'Replace stored key'
                : 'API key'
            }
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
              placeholder={
                (data.state.profiles[editing]?.hasKey ?? false) ? '•••••••• stored' : 'paste key'
              }
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

        <Panel title="Models">
          <p className={css({ fontSize: '12px', color: 'faint', mb: '3', lineHeight: 1.55 })}>
            All four tiers, from one table. Claude Code reads the extended-context marker per
            variable, so a tier left out is the bug where three run wide and the fourth silently
            does not. Blank inherits the provider default.
          </p>
          {data.tiers.map((tier) => (
            <Field key={tier} label={tier}>
              <input
                className={monoInput}
                value={models[tier] ?? ''}
                onChange={(e) => put('models', { ...models, [tier]: e.target.value })}
                placeholder={provider?.defaultModels?.[tier] ?? '—'}
              />
            </Field>
          ))}
        </Panel>

        <Panel title="Behaviour">
          <label className={css({ display: 'flex', gap: '2', alignItems: 'center', mb: '4', fontSize: '13px' })}>
            <input
              type="checkbox"
              checked={Boolean(draft.skipPermissions)}
              onChange={(e) => put('skipPermissions', e.target.checked)}
            />
            Skip permission prompts (--dangerously-skip-permissions)
          </label>

          <div className={css({ fontSize: '12px', fontWeight: 500, color: 'dim', mb: '2' })}>
            Gateway compatibility
          </div>
          {data.compatFlags.map((flag) => (
            <label
              key={flag.id}
              className={css({ display: 'block', mb: '2.5', fontSize: '12.5px', lineHeight: 1.5 })}
            >
              <span className={css({ display: 'flex', gap: '2', alignItems: 'center' })}>
                <input
                  type="checkbox"
                  checked={Boolean(compat[flag.id])}
                  onChange={(e) => put('compat', { ...compat, [flag.id]: e.target.checked })}
                />
                <code className={css({ fontFamily: 'mono', fontSize: '12px' })}>{flag.id}</code>
              </span>
              {flag.consequence ? (
                <span
                  className={css({ display: 'block', color: 'warn', pl: '6', fontSize: '11.5px' })}
                >
                  costs: {flag.consequence}
                </span>
              ) : null}
            </label>
          ))}
        </Panel>

        <div className={css({ display: 'flex', gap: '2', mb: '10' })}>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create profile' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: '5' })}>
        <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>Profiles</h1>
        <Button variant="primary" onClick={() => open(null)}>
          New profile
        </Button>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel title={`${names.length} profile${names.length === 1 ? '' : 's'}`}>
        {names.length === 0 ? (
          <Empty>No profiles yet. Create one to launch anything.</Empty>
        ) : (
          names.map((name) => {
            const p: Profile | undefined = data.state.profiles[name]
            const isDefault = data.state.defaultProfile === name
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
                <Dot tone={p?.hasKey || p?.apiKeyFromEnv ? 'ok' : 'faint'} />
                <div className={css({ flex: 1, minW: 0 })}>
                  <div className={css({ fontSize: '13px', fontWeight: 500 })}>
                    {name}
                    {isDefault ? (
                      <span className={css({ color: 'faint', fontWeight: 400, ml: '2', fontSize: '11.5px' })}>
                        default
                      </span>
                    ) : null}
                  </div>
                  <div className={css({ fontSize: '11.5px', color: 'faint', fontFamily: 'mono' })}>
                    {p?.provider} · {p?.models?.opus || 'provider default'}
                  </div>
                </div>
                {!isDefault ? <Button onClick={() => void setDefault(name)}>Make default</Button> : null}
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
