import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle, monoInput } from '../ui'
import { ModelPicker } from './ModelPicker'

/**
 * Agent profiles — what runs.
 *
 * Holds no credential, which is why this screen has no password field and no
 * redaction to think about. It is also the thing that can be SHARED: one setup
 * ("Claude Code, yolo, glm on every tier") backing several profiles, each
 * pointed at a different account. The listing says when one is shared, because
 * editing a shared setup changes every profile that uses it.
 *
 * The model picker needs a provider to browse, and an agent profile has none —
 * so it borrows one from a profile that uses this setup. When nothing does,
 * there is no catalog to offer and the fields stay plain text, which is the
 * honest answer rather than a picker over a list we cannot obtain.
 */
export function AgentProfiles({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const agentProfiles = Object.entries(data.state.agentProfiles ?? {})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [picking, setPicking] = useState<string | null>(null)

  const open = (name: string | null) => {
    setError(null)
    setWarnings([])
    setEditing(name ?? '')
    setDraft(name ? { ...data.state.agentProfiles[name] } : { models: {}, compat: {} })
  }

  const save = async (name: string) => {
    setError(null)
    try {
      await api.saveAgentProfile(name, draft, data.revision)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const remove = async (name: string) => {
    setError(null)
    try {
      const res = await api.deleteAgentProfile(name, data.revision)
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

  const put = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))
  const models = (draft.models as Record<string, string>) ?? {}
  const compat = (draft.compat as Record<string, boolean>) ?? {}

  /** Which profiles use a given agent profile — the reverse index. */
  const usersOf = (name: string) =>
    Object.entries(data.state.profiles ?? {})
      .filter(([, p]) => p.agentProfile === name)
      .map(([n]) => n)

  if (editing !== null) {
    const isNew = !data.state.agentProfiles?.[editing]
    const users = usersOf(editing)
    // Borrow a provider from a profile that uses this setup, purely so the
    // picker has a catalog to browse.
    const viaProfile = users.map((n) => data.state.profiles[n]).find(Boolean)
    const viaAccount = viaProfile?.accounts?.[0]
      ? data.state.providerAccounts?.[viaProfile.accounts[0]]
      : undefined
    const provider = data.providers.find((p) => p.id === viaAccount?.provider)

    return (
      <>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3', mb: '5' })}>
          <Button onClick={() => setEditing(null)}>← Back</Button>
          <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>
            {isNew ? 'New agent profile' : `Agent profile · ${editing}`}
          </h1>
        </div>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {users.length > 1 ? (
          <Banner tone="warn">
            Shared by {users.length} profiles ({users.join(', ')}). Changes here affect all of them.
          </Banner>
        ) : null}

        <Panel title="Identity">
          {isNew ? (
            <Field label="Name" hint="How profiles refer to this setup.">
              <input
                className={inputStyle}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="main"
              />
            </Field>
          ) : null}
          <Field label="Label">
            <input
              className={inputStyle}
              value={(draft.label as string) ?? ''}
              onChange={(e) => put('label', e.target.value)}
            />
          </Field>
          <Field label="Agent" hint="Which coding CLI to launch. Blank uses Claude Code.">
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
        </Panel>

        <Panel title="Models">
          <p className={css({ textStyle: 'meta', color: 'content.tertiary', mb: '3'})}>
            All four tiers, from one table. Claude Code reads the extended-context marker per
            variable, so a tier left out is the bug where three run wide and the fourth silently
            does not. Blank inherits the provider default.
          </p>
          {data.tiers.map((tier) => (
            <Field key={tier} label={tier}>
              <span className={css({ display: 'flex', gap: '2' })}>
                <input
                  className={monoInput}
                  value={models[tier] ?? ''}
                  onChange={(e) => put('models', { ...models, [tier]: e.target.value })}
                  placeholder={provider?.defaultModels?.[tier] ?? '—'}
                />
                {provider?.catalogId ? (
                  <Button onClick={() => setPicking(tier)}>Browse</Button>
                ) : null}
              </span>
            </Field>
          ))}
          {!provider ? (
            <p className={css({ textStyle: 'meta', color: 'content.tertiary'})}>
              No profile uses this setup yet, so there is no provider to browse a catalog from.
              Type ids by hand, or attach it to a profile first.
            </p>
          ) : null}

          {picking && provider?.catalogId ? (
            <ModelPicker
              catalogId={provider.catalogId}
              tier={picking}
              onClose={() => setPicking(null)}
              onPick={(model) => {
                setDraft((d) => ({
                  ...d,
                  models: { ...((d.models as Record<string, string>) ?? {}), [picking]: model.id },
                  // Capture the MEASURED window alongside the id — the only
                  // moment it is known, and what later lets swisscode set an
                  // auto-compact window without ever guessing one.
                  ...(model.context
                    ? {
                        contextWindows: {
                          ...((d.contextWindows as Record<string, number>) ?? {}),
                          [model.id]: model.context,
                        },
                      }
                    : {}),
                }))
                setPicking(null)
              }}
            />
          ) : null}
        </Panel>

        <Panel title="Behaviour">
          <label className={css({ display: 'flex', gap: '2', alignItems: 'center', mb: '4', textStyle: 'body' })}>
            <input
              type="checkbox"
              checked={Boolean(draft.skipPermissions)}
              onChange={(e) => put('skipPermissions', e.target.checked)}
            />
            Skip permission prompts (--dangerously-skip-permissions)
          </label>

          <div className={css({ textStyle: 'meta', fontWeight: 'medium', color: 'content.secondary', mb: '2' })}>
            Gateway compatibility
          </div>
          {data.compatFlags.map((flag) => (
            <label key={flag.id} className={css({ display: 'block', mb: '2.5', textStyle: 'meta'})}>
              <span className={css({ display: 'flex', gap: '2', alignItems: 'center' })}>
                <input
                  type="checkbox"
                  checked={Boolean(compat[flag.id])}
                  onChange={(e) => put('compat', { ...compat, [flag.id]: e.target.checked })}
                />
                <code className={css({ fontFamily: 'mono', textStyle: 'meta' })}>{flag.id}</code>
              </span>
              {/* A flag that trades something away says what it costs, here as
                  well as on stderr. */}
              {flag.consequence ? (
                <span className={css({ display: 'block', color: 'warn.default', pl: '6', textStyle: 'meta' })}>
                  costs: {flag.consequence}
                </span>
              ) : null}
            </label>
          ))}
        </Panel>

        <div className={css({ display: 'flex', gap: '2', mb: '10' })}>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create agent profile' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: '5' })}>
        <h1 className={css({ textStyle: 'heading', fontWeight: 'title' })}>Agent profiles</h1>
        <Button variant="primary" onClick={() => open(null)}>
          New agent profile
        </Button>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      <Panel title={`${agentProfiles.length} setup${agentProfiles.length === 1 ? '' : 's'}`}>
        {agentProfiles.length === 0 ? (
          <Empty>None yet. An agent profile is a coding CLI plus how it should behave.</Empty>
        ) : (
          agentProfiles.map(([name, ap]) => {
            const users = usersOf(name)
            const pinned = data.tiers.filter((t) => ap.models?.[t]).length
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
                <Dot tone={users.length > 0 ? 'ok' : 'neutral'} />
                <div className={css({ flex: '1', minW: '0' })}>
                  <div className={css({ textStyle: 'body', fontWeight: 'medium' })}>
                    {name}
                    {users.length > 1 ? (
                      <span className={css({ color: 'warn.default', fontWeight: 'normal', ml: '2', textStyle: 'meta' })}>
                        shared
                      </span>
                    ) : null}
                  </div>
                  <div className={css({ textStyle: 'meta', color: 'content.tertiary', fontFamily: 'mono' })}>
                    {ap.agent ?? 'claude-code'}
                    {' · '}
                    {pinned > 0 ? `${pinned}/${data.tiers.length} tiers pinned` : 'provider defaults'}
                    {' · '}
                    {users.length > 0 ? `used by ${users.join(', ')}` : 'unused'}
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
