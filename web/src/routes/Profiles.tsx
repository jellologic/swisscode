import { useState } from 'react'
import { css, cva } from '../../styled-system/css'
import { ApiError, api, type Bootstrap, type SelectionStrategy } from '../api'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Code,
  DataList,
  DataRow,
  Dot,
  Empty,
  Field,
  FormActions,
  Inline,
  KeyValue,
  KeyValueList,
  Mono,
  Note,
  PageHeader,
  Panel,
  Radio,
  Stack,
  inputStyle,
  selectStyle,
} from '../ui'

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

const strategyLabel = (id: SelectionStrategy): string =>
  STRATEGIES.find((s) => s.id === id)?.label ?? id

/**
 * A reference and the thing it dereferences to, drawn as ONE chip.
 *
 * A profile is nothing except its references, so they are the row's content
 * rather than a sentence about it — and `work → anthropic` has to stay readable
 * as one unit when it is the third of four on a wrapping line, which a run of
 * middot-separated identifiers does not. Local to this route because it is the
 * only screen that shows a reference: `Badge` is a status and `Code` is a
 * literal inside prose, and a pointer is neither.
 */
const refChip = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '1',
    px: '1.5',
    py: '0.5',
    borderRadius: 'xs',
    textStyle: 'code',
    whiteSpace: 'nowrap',
  },
  variants: {
    tone: {
      default: { bg: 'surface.hover', color: 'content.secondary' },
      danger: { bg: 'danger.subtle', color: 'danger.default' },
    },
  },
  defaultVariants: { tone: 'default' },
})

// Only the intact chip dims its resolved half; a dangling one stays one solid
// red unit, because the part that is wrong is the arrow, not the target.
const refResolved = css({ color: 'content.tertiary' })

function Ref({
  name,
  to,
  missing = false,
}: {
  name: string
  /** What the name resolves to. Omitted when the target names nothing further. */
  to?: string | undefined
  missing?: boolean
}) {
  return (
    <span className={refChip({ tone: missing ? 'danger' : 'default' })}>
      <span>{name}</span>
      {to ? <span className={missing ? undefined : refResolved}>→ {to}</span> : null}
    </span>
  )
}

// `Checkbox` renders its label into a <span>, so this is inline-flex rather
// than an `Inline` — whose <div> would be invalid markup in that slot.
const choiceLabelRow = css({ display: 'inline-flex', alignItems: 'baseline', gap: '2' })

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
        <PageHeader
          title={isNew ? 'New profile' : `Profile · ${editing}`}
          onBack={() => setEditing(null)}
        />
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
              className={selectStyle}
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

        <Panel
          title="Accounts"
          description="Who pays, in preference order. Attach more than one to rotate or to pick by remaining capacity."
        >
          <Stack gap="3">
            <Stack gap="2">
              {accountNames.map((n) => {
                const a = data.state.providerAccounts[n]!
                return (
                  <Checkbox
                    key={n}
                    checked={accounts.includes(n)}
                    onChange={(on) =>
                      put('accounts', on ? [...accounts, n] : accounts.filter((x) => x !== n))
                    }
                    label={
                      <span className={choiceLabelRow}>
                        <span>{n}</span>
                        <span className={refResolved}>
                          <Mono>{a.provider}</Mono>
                        </span>
                        {a.hasKey || a.apiKeyFromEnv ? null : <Badge tone="warn">no key</Badge>}
                      </span>
                    }
                  />
                )
              })}
            </Stack>
            {accounts.length === 0 ? (
              <Note tone="danger">
                A profile with no account has nothing to authenticate with and will not launch.
              </Note>
            ) : null}
          </Stack>
        </Panel>

        {accounts.length > 1 ? (
          <Panel title="Selection">
            <Stack gap="3">
              {STRATEGIES.map((s) => (
                <Radio
                  key={s.id}
                  name="strategy"
                  checked={strategy === s.id}
                  onSelect={() => put('strategy', s.id)}
                  label={s.label}
                  note={s.note}
                />
              ))}
            </Stack>
          </Panel>
        ) : null}

        <FormActions>
          <Button
            variant="primary"
            onClick={() => void save(editing)}
            disabled={!editing.trim() || !canCreate || accounts.length === 0}
          >
            {isNew ? 'Create profile' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </FormActions>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Profiles"
        meta={`${names.length} profile${names.length === 1 ? '' : 's'}`}
        description={
          <>
            The pairing of what runs with who pays. Whichever profile is marked default is the one{' '}
            <Code>swisscode</Code> launches when nothing else names one — no argument, no flag, no
            directory binding.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => open(null)}>
            New profile
          </Button>
        }
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel flush>
        {names.length === 0 ? (
          <Empty>No profiles yet. A profile pairs an agent profile with one or more accounts.</Empty>
        ) : (
          <DataList>
            {names.map((name) => {
              const p = data.state.profiles[name]!
              const isDefault = data.state.defaultProfile === name
              // Report what it RESOLVES to, not what it references — a list of
              // key names would make the reader do the dereference in their head.
              const agentProfile = data.state.agentProfiles?.[p.agentProfile]
              const attached = p.accounts ?? []
              const first = attached[0]
              const account = first ? data.state.providerAccounts?.[first] : undefined
              const broken = !agentProfile || attached.length === 0 || !account
              return (
                <DataRow
                  key={name}
                  align="start"
                  leading={<Dot tone={broken ? 'danger' : 'ok'} />}
                  title={
                    <Inline gap="2" align="baseline" wrap>
                      <span>{name}</span>
                      {isDefault ? <Badge tone="accent">default</Badge> : null}
                    </Inline>
                  }
                  meta={
                    <Stack gap="1.5">
                      <KeyValueList>
                        <KeyValue label="Agent profile">
                          <Ref
                            name={p.agentProfile || 'none'}
                            // `agent` is OPTIONAL and blank is the documented
                            // default, so `?? 'claude-code'` is the resolution —
                            // without it an agent profile that never named one
                            // resolved to nothing at all here while the Agent
                            // profiles screen showed the same record resolving
                            // fine.
                            to={agentProfile ? (agentProfile.agent ?? 'claude-code') : 'missing'}
                            missing={!agentProfile}
                          />
                        </KeyValue>
                        {attached.length === 0 ? (
                          <KeyValue label="Accounts" tone="danger">
                            none
                          </KeyValue>
                        ) : (
                          <KeyValue label="Accounts">
                            <Inline gap="1.5" wrap>
                              {attached.map((n) => {
                                const a = data.state.providerAccounts?.[n]
                                return <Ref key={n} name={n} to={a ? a.provider : 'missing'} missing={!a} />
                              })}
                            </Inline>
                          </KeyValue>
                        )}
                        {attached.length > 1 ? (
                          <KeyValue label="Selection">
                            {/*
                              The stored id first, the sentence second. Every
                              other fact in this list is the literal that is in
                              config.json, and the whole use for this row is
                              reconciling the screen against that file — a label
                              on its own means looking up which of three strings
                              produced it.
                            */}
                            <Mono>{p.strategy ?? 'single'}</Mono>{' '}
                            <span className={refResolved}>
                              {strategyLabel(p.strategy ?? 'single')}
                            </span>
                          </KeyValue>
                        ) : null}
                      </KeyValueList>
                      {broken ? <Note tone="danger">broken reference — open to repair</Note> : null}
                    </Stack>
                  }
                  actions={
                    <>
                      {!isDefault ? (
                        <Button
                          variant="ghost"
                          onClick={() => void act(() => api.setDefault(name, data.revision))}
                        >
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
                    </>
                  }
                />
              )
            })}
          </DataList>
        )}
      </Panel>
    </>
  )
}
