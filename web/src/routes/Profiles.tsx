import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap, type SelectionStrategy } from '../api'
import { Banner, Button, Dot, Empty, Field, Panel, inputStyle } from '../ui'

/**
 * Profiles — the pairing, and the only screen that expresses MULTIPLE accounts.
 *
 * Holds no credential and no agent settings of its own: it names one agent
 * profile, one or more accounts, and the rule for choosing among them. Editing
 * what those references point AT happens on the other two screens, which is the
 * whole reason the split exists.
 */
const STRATEGIES: { id: SelectionStrategy; label: string; note: string }[] = [
  { id: 'single', label: 'Single', note: 'Always the first account. No state, no surprises.' },
  {
    id: 'round-robin',
    label: 'Round robin',
    note:
      'Advances one account per LAUNCH, not per request — swisscode hands off and exits, so ' +
      'there is nothing left to rotate mid-session.',
  },
  {
    id: 'usage',
    label: 'By remaining capacity',
    note:
      'Picks the account with the most left, from the last measurement. swisscode cannot check ' +
      'this at launch, so it uses what the doctor or this UI cached — and falls back to the ' +
      'first account, saying so, when nothing has measured it yet.',
  },
]

export function Profiles({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const names = Object.keys(data.state.profiles ?? {})
  const accountNames = Object.keys(data.state.providerAccounts ?? {})
  const agentProfileNames = Object.keys(data.state.agentProfiles ?? {})

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)

  const open = (name: string | null) => {
    setError(null)
    setEditing(name ?? '')
    setDraft(
      name
        ? { ...data.state.profiles[name] }
        : {
            agentProfile: agentProfileNames[0] ?? '',
            accounts: accountNames[0] ? [accountNames[0]] : [],
            strategy: 'single',
          },
    )
  }

  const save = async (name: string) => {
    setError(null)
    try {
      await api.saveProfile(name, draft, data.revision)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const put = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))
  const accounts = (draft.accounts as string[]) ?? []
  const strategy = (draft.strategy as SelectionStrategy) ?? 'single'

  if (editing !== null) {
    const isNew = !data.state.profiles?.[editing]
    const canCreate = agentProfileNames.length > 0 && accountNames.length > 0
    return (
      <>
        <div className={css({ display: 'flex', alignItems: 'center', gap: '3', mb: '5' })}>
          <Button onClick={() => setEditing(null)}>← Back</Button>
          <h1 className={css({ fontSize: '15px', fontWeight: 600 })}>
            {isNew ? 'New profile' : `Profile · ${editing}`}
          </h1>
        </div>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!canCreate ? (
          <Banner tone="warn">
            A profile references an account and an agent profile, so at least one of each has to
            exist first.
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
          <Field label="Agent profile" hint="What runs. Edit the setup itself under Agent profiles.">
            <select
              className={inputStyle}
              value={String(draft.agentProfile ?? '')}
              onChange={(e) => put('agentProfile', e.target.value)}
            >
              {agentProfileNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                  {data.state.agentProfiles[n]?.agent ? ` — ${data.state.agentProfiles[n]!.agent}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </Panel>

        <Panel title="Accounts">
          <p className={css({ fontSize: '12px', color: 'faint', mb: '3', lineHeight: 1.55 })}>
            Who pays, in preference order. Attach more than one to rotate or to pick by remaining
            capacity.
          </p>
          {accountNames.map((n) => {
            const on = accounts.includes(n)
            const a = data.state.providerAccounts[n]!
            return (
              <label
                key={n}
                className={css({ display: 'flex', gap: '2', alignItems: 'baseline', mb: '2', fontSize: '13px' })}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    put('accounts', e.target.checked ? [...accounts, n] : accounts.filter((x) => x !== n))
                  }
                />
                <span>
                  {n}
                  <span className={css({ color: 'faint', fontSize: '11.5px', ml: '2', fontFamily: 'mono' })}>
                    {a.provider}
                    {a.hasKey || a.apiKeyFromEnv ? '' : '  · no key'}
                  </span>
                </span>
              </label>
            )
          })}
          {accounts.length === 0 ? (
            <p className={css({ fontSize: '11.5px', color: 'danger', mt: '2' })}>
              A profile with no account has nothing to authenticate with and will not launch.
            </p>
          ) : null}
        </Panel>

        {accounts.length > 1 ? (
          <Panel title="Selection">
            {STRATEGIES.map((s) => (
              <label key={s.id} className={css({ display: 'block', mb: '3', fontSize: '13px' })}>
                <span className={css({ display: 'flex', gap: '2', alignItems: 'center' })}>
                  <input
                    type="radio"
                    name="strategy"
                    checked={strategy === s.id}
                    onChange={() => put('strategy', s.id)}
                  />
                  {s.label}
                </span>
                <span
                  className={css({ display: 'block', color: 'faint', pl: '6', fontSize: '11.5px', lineHeight: 1.55 })}
                >
                  {s.note}
                </span>
              </label>
            ))}
          </Panel>
        ) : null}

        <div className={css({ display: 'flex', gap: '2', mb: '10' })}>
          <Button
            variant="primary"
            onClick={() => void save(editing)}
            disabled={!editing.trim() || !canCreate || accounts.length === 0}
          >
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
          <Empty>No profiles yet. A profile pairs an agent profile with one or more accounts.</Empty>
        ) : (
          names.map((name) => {
            const p = data.state.profiles[name]!
            const isDefault = data.state.defaultProfile === name
            // Report what it RESOLVES to, not what it references — a list of
            // key names would make the reader do the dereference in their head.
            const first = p.accounts?.[0]
            const account = first ? data.state.providerAccounts?.[first] : undefined
            const broken =
              !data.state.agentProfiles?.[p.agentProfile] || (p.accounts ?? []).length === 0 || !account
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
                <Dot tone={broken ? 'danger' : 'ok'} />
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
                    {broken
                      ? 'broken reference — open to repair'
                      : `${p.agentProfile} · ${first} → ${account!.provider}` +
                        ((p.accounts?.length ?? 0) > 1
                          ? `  (+${p.accounts!.length - 1}, ${p.strategy ?? 'single'})`
                          : '')}
                  </div>
                </div>
                {!isDefault ? (
                  <Button onClick={() => void act(() => api.setDefault(name, data.revision))}>
                    Make default
                  </Button>
                ) : null}
                <Button onClick={() => open(name)}>Edit</Button>
                <Button
                  variant="danger"
                  onClick={() => void act(() => api.deleteProfile(name, data.revision))}
                >
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
