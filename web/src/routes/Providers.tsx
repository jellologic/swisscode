import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Code,
  DataList,
  DataRow,
  Empty,
  Field,
  FormActions,
  Mono,
  PageHeader,
  Panel,
  inputStyle,
  monoInput,
  selectStyle,
} from '../ui'
import { EmptyState } from '../Brand'

/**
 * Shipped presets are read-only here and say so. They are constants in source,
 * guarded by tests a config file cannot reach; presenting them as editable
 * would imply a capability that does not exist.
 *
 * That difference is the screen's whole layout argument: the two lists are
 * separate panels, and only the editable one has an actions column. Anything
 * that reads the same on both sides is a promise the shipped list cannot keep.
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
        <PageHeader
          title={isNew ? 'New provider' : 'Provider'}
          meta={isNew ? undefined : <Mono>{editing}</Mono>}
          onBack={() => setEditing(null)}
        />

        {error ? (
          <Banner tone="danger">
            {errors.length > 1 ? (
              <ul className={css({ pl: '4', display: 'grid', gap: '1' })}>
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
        </Panel>

        {/*
          Its own panel because the choice is not cosmetic: the variable name is
          what decides the header the agent sends, so it belongs beside the
          "no credential at all" switch rather than trailing the URL fields.
        */}
        <Panel
          title="Credential"
          description={
            <>
              The variable your key is exported as, which is also what picks the header:{' '}
              <Code>ANTHROPIC_API_KEY</Code> is sent as <Code>x-api-key</Code>,{' '}
              <Code>ANTHROPIC_AUTH_TOKEN</Code> as <Code>Authorization: Bearer</Code>.
            </>
          }
        >
          <Field label="Credential header">
            <select
              className={selectStyle}
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
          <Checkbox
            checked={Boolean(draft.credentialOptional)}
            onChange={(v) => put('credentialOptional', v)}
            label="This endpoint does not require a credential"
            /*
              What the flag DOES is stop the wizard and the doctor demanding a
              credential. The launch still sends a key when there is one to send:
              the no-key path is taken only when no account for this provider
              exists and the variable is unset in the shell.
            */
            note="swisscode stops asking for a credential, so a profile pointed here can launch with no key at all — which is what a local server wants and what anything on the public internet does not."
          />
        </Panel>

        <Panel
          title="Default models"
          description="Optional. A profile can override any of these. Do not type an extended-context marker — that suffix is derived from a verified capability, and an id the endpoint does not recognise fails hard."
        >
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

        <FormActions>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create provider' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </FormActions>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Providers"
        meta={`${custom.length} custom · ${shipped.length} shipped`}
        description="A provider is an endpoint plus the credential variable it expects. An account names one and holds the key for it; a profile names accounts."
        actions={
          <Button variant="primary" onClick={() => open(null)}>
            New provider
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      <Panel
        title="Your providers"
        description="Written to your config file, so these are the only ones this screen can change."
        flush
      >
        {custom.length === 0 ? (
          <EmptyState>No custom providers yet. Add one for a gateway or a local server swisscode does not ship a preset for.</EmptyState>
        ) : (
          <DataList>
            {custom.map(([id, p]) => (
              <DataRow
                key={id}
                title={p.label}
                meta={
                  <>
                    <Mono>{id}</Mono> · <Mono>{p.baseUrl}</Mono>
                  </>
                }
                actions={
                  <>
                    <Button onClick={() => open(id)}>Edit</Button>
                    <Button variant="danger" onClick={() => void remove(id)}>
                      Delete
                    </Button>
                  </>
                }
              />
            ))}
          </DataList>
        )}
      </Panel>

      <Panel
        title="Shipped presets"
        description="Constants in swisscode's source, checked by tests that a config file cannot reach — including verified extended-context claims."
        // The badge sits in the header rather than on every row: it is a fact
        // about the whole list, and repeating it fifteen times would out-shout
        // the one thing each row is actually for.
        action={<Badge tone="neutral">read-only</Badge>}
        flush
      >
        <DataList>
          {shipped.map((p) => (
            <DataRow
              key={p.id}
              title={p.label}
              // A null base URL means the agent's own endpoint, which is prose
              // and not an identifier — so it does not get the mono treatment.
              meta={p.baseUrl ? <Mono>{p.baseUrl}</Mono> : 'agent default'}
              actions={p.catalogId ? <Badge tone="neutral">browsable catalog</Badge> : null}
            />
          ))}
        </DataList>
      </Panel>
    </>
  )
}
