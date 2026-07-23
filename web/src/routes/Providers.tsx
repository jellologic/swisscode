import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle, monoInput } from '../ui'

/**
 * Shipped presets are read-only here and say so. They are constants in source,
 * guarded by tests a config file cannot reach; presenting them as editable
 * would imply a capability that does not exist.
 *
 * Custom providers are editable, and every refusal from the server is rendered
 * verbatim — those messages are the runtime twin of the shipped descriptors'
 * test suite, so they are the most useful thing on the screen when a save fails.
 */
export function Providers({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const custom = Object.entries(data.customProviders)
  const shipped = data.providers.filter((p) => data.reservedProviderIds.includes(p.id))

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])

  const open = (id: string | null) => {
    setError(null)
    setErrors([])
    setWarnings([])
    setEditing(id ?? '')
    setDraft(id ? { ...data.customProviders[id] } : { label: '', baseUrl: '', defaultModels: {} })
  }

  const save = async (id: string) => {
    setError(null)
    setErrors([])
    try {
      const res = await api.saveProvider(id, draft, data.revision)
      setWarnings(res.warnings ?? [])
      setEditing(null)
      await reload()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setErrors(err.errors)
      } else setError(String(err))
    }
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      const res = await api.deleteProvider(id, data.revision)
      if (res.orphanedProfiles.length > 0) {
        // Reported, never silently repaired: only the user knows where those
        // profiles should point now.
        setWarnings([
          `These profiles still name "${id}" and will not launch until you repoint them: ` +
            res.orphanedProfiles.join(', '),
        ])
      }
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const field = (k: string) => (draft[k] as string) ?? ''
  const put = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))
  const models = (draft.defaultModels as Record<string, string>) ?? {}

  if (editing !== null) {
    const isNew = !data.customProviders[editing]
    return (
      <>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3', mb: '5' })}>
          <Button onClick={() => setEditing(null)}>← Back</Button>
          <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>
            {isNew ? 'New provider' : `Provider · ${editing}`}
          </h1>
        </div>

        {error ? (
          <Banner tone="danger">
            {errors.length > 1 ? (
              <ul className={css({ pl: '4' })}>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              error
            )}
          </Banner>
        ) : null}

        <Panel title="Endpoint">
          {isNew ? (
            <Field label="id" hint="Lowercase. Cannot shadow a shipped preset.">
              <input
                className={monoInput}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="my-gateway"
              />
            </Field>
          ) : null}
          <Field label="Label">
            <input className={inputStyle} value={field('label')} onChange={(e) => put('label', e.target.value)} />
          </Field>
          <Field
            label="Base URL"
            hint="Anthropic-compatible route. Do not append /v1 — that is the OpenAI-compatible one, and swisscode would request /v1/v1/messages."
          >
            <input
              className={monoInput}
              value={field('baseUrl')}
              onChange={(e) => put('baseUrl', e.target.value)}
              placeholder="https://gateway.example.com/anthropic"
            />
          </Field>
          <Field label="Credential header">
            <select
              className={inputStyle}
              value={field('credentialEnv') || data.credentialEnvs[0]}
              onChange={(e) => put('credentialEnv', e.target.value)}
            >
              {data.credentialEnvs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <label className={css({ display: 'flex', gap: '2', alignItems: 'center', mb: '4', textStyle: 'body' })}>
            <input
              type="checkbox"
              checked={Boolean(draft.credentialOptional)}
              onChange={(e) => put('credentialOptional', e.target.checked)}
            />
            This endpoint does not require a credential
          </label>
        </Panel>

        <Panel title="Default models">
          <p className={css({ textStyle: 'meta', color: 'content.tertiary', mb: '3'})}>
            Optional. A profile can override any of these. Do not type an extended-context
            marker — that suffix is derived from a verified capability, and an id the endpoint
            does not recognise fails hard.
          </p>
          {data.tiers.map((tier) => (
            <Field key={tier} label={tier}>
              <input
                className={monoInput}
                value={models[tier] ?? ''}
                onChange={(e) => put('defaultModels', { ...models, [tier]: e.target.value })}
              />
            </Field>
          ))}
        </Panel>

        <div className={css({ display: 'flex', gap: '2', mb: '10' })}>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create provider' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: '5' })}>
        <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>Providers</h1>
        <Button variant="primary" onClick={() => open(null)}>
          New provider
        </Button>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      <Panel title="Your providers">
        {custom.length === 0 ? (
          <Empty>None yet. Add one for a gateway or a local server swisscode does not ship a preset for.</Empty>
        ) : (
          custom.map(([id, p]) => (
            <div
              key={id}
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
              <Dot tone="ok" />
              <div className={css({ flex: '1', minW: '0' })}>
                <div className={css({ textStyle: 'body', fontWeight: 'medium' })}>{p.label}</div>
                <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono' })}>
                  {id} · {p.baseUrl}
                </div>
              </div>
              <Button onClick={() => open(id)}>Edit</Button>
              <Button variant="danger" onClick={() => void remove(id)}>
                Delete
              </Button>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Shipped presets">
        <p className={css({ textStyle: 'meta', color: 'content.tertiary', mb: '3'})}>
          Read-only. These are constants in swisscode's source, checked by tests that a config
          file cannot reach — including verified extended-context claims.
        </p>
        {shipped.map((p) => (
          <div
            key={p.id}
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '3',
              py: '2',
              borderBottom: '[1px solid]',
              borderColor: 'border.subtle',
              _last: { borderBottom: 'none' },
            })}
          >
            <div className={css({ flex: '1', minW: '0' })}>
              <div className={css({ textStyle: 'body' })}>{p.label}</div>
              <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono' })}>
                {p.baseUrl ?? 'agent default'}
              </div>
            </div>
            {p.catalogId ? (
              <span className={css({ textStyle: 'micro', color: 'content.tertiary' })}>browsable catalog</span>
            ) : null}
          </div>
        ))}
      </Panel>
    </>
  )
}
