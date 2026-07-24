import { useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type Bootstrap, type ProviderAccount, type UsageReport } from '../api'
import {
  Badge,
  Banner,
  Button,
  Code,
  DataList,
  DataRow,
  Dot,
  Empty,
  Field,
  FormActions,
  Inline,
  Mono,
  Note,
  PageHeader,
  Panel,
  SectionLabel,
  SegmentedControl,
  Stack,
  inputStyle,
  monoInput,
  selectStyle,
} from '../ui'
import { EmptyState } from '../Brand'
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

/* --------------------------------------------------------------- row layout */

/**
 * The row's lower block: three columns, one fact each, the same fact every row.
 *
 * ONE TEMPLATE FOR BOTH LINES is the whole idea. The measured figures are extra
 * CELLS of this grid rather than a paragraph appended underneath, so `5h` lands
 * under the credential it was read from and every account's percentages sit on
 * the same two vertical edges. That is what turns five facts on two ragged
 * lines into something read down a column — and it is why measuring adds one
 * grid row to every account at once instead of a stray third line to some.
 */
const rowGrid = css({
  display: 'grid',
  gridTemplateColumns: '[7rem 1fr 1fr]',
  columnGap: '4',
  rowGap: '1.5',
  alignItems: 'baseline',
  // Monospace for the whole block, not just the ids: every cell in it is an
  // identifier or a figure, and a column of percentages set in a proportional
  // face does not line up no matter what the grid does.
  textStyle: 'code',
  // A grid item's automatic minimum size is its MIN-CONTENT, so one long login
  // — an email is a single unbreakable word — would widen its `1fr` track and
  // knock the column out of line for every other row. Zeroing the minimum is
  // what keeps the tracks equal; the wrap is what keeps the text inside them.
  '& > *': { minW: '0', overflowWrap: 'break-word' },
})

/** Measured figures sit one step out of the tertiary line they share. */
const measuredCell = css({ color: 'content.secondary' })
/** The one number worth finding at a glance. */
const figure = css({ color: 'content.primary', fontWeight: 'medium' })
const windowLabel = css({ color: 'content.tertiary' })
/** An account with nothing to measure says so once, across the whole grid. */
const usageNote = css({ gridColumn: '[1 / -1]', color: 'content.tertiary' })
/**
 * The conflict is the only sentence on this screen allowed a status colour.
 *
 * It stays in the credential cell rather than becoming a page banner, because
 * the row is where the problem is and a banner would say "something is wrong"
 * without saying which of eight accounts. The dot and the badge do the finding;
 * this does the explaining, and neither needs to shout to be the only red on
 * the page.
 */
const conflictCell = css({ color: 'danger.default' })
// No `fontWeight` here: `textStyle: 'meta'` already sets 400 on this span, so
// an override next to it would be overriding the value with itself.
const accountLabel = css({ textStyle: 'meta', color: 'content.tertiary' })

const CREDENTIAL_MODES = [
  { id: 'key', label: 'API key' },
  { id: 'session', label: 'Existing Claude Code login' },
] as const

/** Ties the visible caption to the group it names. One editor is open at a time. */
const MODE_LABEL_ID = 'account-credential-mode'

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
    // Session mode belongs to the first-party Anthropic endpoint: a provider
    // with no baseUrl of its own that is not the custom "ask me" one. A gateway
    // (baseUrl set) or a custom endpoint cannot read a ~/.claude login.
    const sessionCapable = Boolean(provider && provider.baseUrl === null && !provider.askBaseUrl)
    const mode: 'key' | 'session' =
      draft.configDir && sessionCapable ? 'session' : 'key'
    return (
      <>
        <PageHeader
          title={isNew ? 'New account' : `Account · ${editing}`}
          onBack={() => setEditing(null)}
        />
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
              className={selectStyle}
              value={String(draft.provider ?? '')}
              onChange={(e) => {
                const nextId = e.target.value
                const next = data.providers.find((p) => p.id === nextId)
                const nextSessionCapable = Boolean(next && next.baseUrl === null && !next.askBaseUrl)
                setDraft((d) => ({
                  ...d,
                  provider: nextId,
                  // A session login belongs to the first-party Anthropic
                  // endpoint; switching to a gateway must not leave a stale
                  // configDir that would send the ~/.claude token to a foreign
                  // host. Drop it, reverting the account to key mode.
                  ...(nextSessionCapable ? {} : { configDir: '' }),
                }))
              }}
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
          <Stack gap="4">
            {/*
              A choice of MODE, so a segmented control rather than a select: the
              two answers are the two shapes an account can have, and a closed
              menu that has to be opened to learn what the alternative even is
              hides the one decision this panel exists to make.
            */}
            <Stack gap="2" align="start">
              {/*
                The caption is POINTED AT rather than repeated. A `SegmentedControl`
                is a `role="group"`, not a form control, so there is no `htmlFor`
                that could reach it; an `aria-label` saying the same words is a
                second copy that drifts, and it leaves the visible caption
                naming nothing.
              */}
              <SectionLabel id={MODE_LABEL_ID}>How this account authenticates</SectionLabel>
              {sessionCapable ? (
                <>
                  <SegmentedControl
                    labelledBy={MODE_LABEL_ID}
                    options={CREDENTIAL_MODES}
                    value={mode}
                    onChange={(id) => put('configDir', id === 'session' ? '~/.claude' : '')}
                  />
                  <Note>
                    A key, or a login the agent already performed. Never both — the server refuses
                    that rather than picking one.
                  </Note>
                </>
              ) : (
                // Session mode is a subscription login held in ~/.claude, which
                // only the first-party Anthropic endpoint reads. A gateway or a
                // custom endpoint authenticates with a key, so the choice is not
                // offered — it could only build an account that ships the wrong
                // token to the wrong host.
                <Note>{provider?.label ?? 'This provider'} authenticates with an API key.</Note>
              )}
            </Stack>

            {/*
              A plain wrapper, deliberately: `Field` owns its own bottom margin,
              so a run of them must NOT become `Stack` children or every gap is
              counted twice. The Stack above spaces the two groups, not the
              fields inside this one.
            */}
            <div>
              {mode === 'session' ? (
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
                    <Code>swisscode config accounts login {editing || '<name>'}</Code> and complete{' '}
                    <Code>/login</Code> inside the agent. This page only points the account at a
                    directory.
                  </Banner>
                  {!isNew && data.logins ? (
                    <Note>
                      currently: <Mono>{data.logins[editing] ?? 'not logged in'}</Mono>
                    </Note>
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
            </div>
          </Stack>
        </Panel>

        <FormActions>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create account' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </FormActions>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        meta={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
        description="Who pays: a provider plus the credential that authenticates against it — either an API key, or a directory holding a login the agent already performed. Profiles name one or more."
        actions={
          <>
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
          </>
        }
      />
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

      {/*
        What the figures mean belongs to the LIST, not to the page, so it is the
        panel's description: it appears directly above the rows it explains and
        disappears with them, instead of floating as a stray paragraph the
        moment somebody clicks Measure.
      */}
      <Panel
        flush
        description={
          usage?.checkedAt ? (
            <>
              Measured {new Date(usage.checkedAt).toLocaleTimeString()}. “% left” is the tighter of
              the two windows, never their average — an account at 5% of its 5-hour window and 95%
              of its weekly one has almost nothing left. Profiles using the <Code>usage</Code>{' '}
              strategy now select on these figures.
            </>
          ) : undefined
        }
      >
        {accounts.length === 0 ? (
          <EmptyState>No accounts yet. An account is a provider plus the credential that pays for it.</EmptyState>
        ) : (
          <DataList>
            {accounts.map(([name, a]) => {
              // The reverse index: a profile lists its accounts, but only this
              // view can say which profiles an account backs — the question you
              // have before deleting one or rotating a key.
              const usedBy = accountsUsedBy(data.state.profiles, name)
              const login = a.configDir ? (data.logins?.[name] ?? null) : null
              const measured = usage?.accounts.find((m) => m.name === name)
              const conflict = credentialSource(a) === 'conflict'
              return (
                <DataRow
                  key={name}
                  align="start"
                  leading={
                    /*
                      Three states, not two. A session account is "ready" when
                      someone has LOGGED IN there, not when a path is set — a
                      directory nobody has logged into looks identical in
                      config.json and fails only after execve, so the dot tracks
                      the login rather than the field. An account holding BOTH a
                      key and a login is not merely unready, it is misconfigured
                      in a way that silently ignores one of them, and a grey dot
                      would file that under "not set up yet".
                    */
                    <Dot tone={conflict ? 'danger' : ready(a, login) ? 'ok' : 'neutral'} />
                  }
                  title={
                    <Inline gap="2" align="baseline" wrap>
                      <span>{name}</span>
                      {a.label ? <span className={accountLabel}>{a.label}</span> : null}
                      {conflict ? <Badge tone="danger">conflict</Badge> : null}
                    </Inline>
                  }
                  meta={
                    <div className={rowGrid}>
                      <div>{a.provider}</div>
                      <div className={conflict ? conflictCell : undefined}>
                        {credentialLine(a, login)}
                      </div>
                      <div>{usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'unused'}</div>
                      {measured ? (
                        measured.mode === 'key' ? (
                          <div className={usageNote}>key account — no subscription window</div>
                        ) : measured.remaining === null ? (
                          <div className={usageNote}>could not be measured</div>
                        ) : (
                          <>
                            <div className={measuredCell}>
                              <span className={figure}>{measured.remaining}%</span> left
                            </div>
                            <div className={measuredCell}>
                              <span className={windowLabel}>5h</span>{' '}
                              {formatWindow(measured.fiveHour)}
                            </div>
                            <div className={measuredCell}>
                              <span className={windowLabel}>7d</span>{' '}
                              {formatWindow(measured.sevenDay)}
                            </div>
                          </>
                        )
                      ) : null}
                    </div>
                  }
                  actions={
                    <>
                      <Button onClick={() => open(name)}>Edit</Button>
                      <Button variant="danger" onClick={() => void remove(name)}>
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
