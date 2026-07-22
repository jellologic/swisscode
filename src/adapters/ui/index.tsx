import React, { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import { TIERS } from '../../core/tiers.ts'
import { NAME_RE, validateProfileName } from '../../core/migrate.ts'
import { bindPath, normalizeBindingKey, pruneBindingsForProfile, unbindPath } from '../../core/binding.ts'
import { registry as defaultRegistry } from '../providers/registry.ts'
import { createFsConfigStore } from '../store/fs-config-store.ts'
import { createFsCacheStore } from '../store/fs-cache-store.ts'
import { createCatalogRegistry } from '../catalog/registry.ts'
import { fetchNet } from '../net/fetch-net.ts'
import { systemClock } from '../clock/system-clock.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { ConfirmDelete, ProfileActions, ProfilePicker } from './ProfilePicker.tsx'
import type { ProfileAction } from './ProfilePicker.tsx'
import type { Tier, TierRecord, ProviderDescriptor, ProviderRegistryPort } from '../../ports/provider.ts'
import type { Profile, State, ConfigStorePort } from '../../ports/config-store.ts'
import type { CatalogRegistryPort } from '../../ports/catalog.ts'

export { ModelPicker, ProfilePicker }

const mask = (s: string): string => (s ? '•'.repeat(Math.min(s.length, 24)) : '')

/**
 * A model box for EVERY tier, blank.
 *
 * The return type is the whole point: `TierRecord<string>` is exhaustive, so
 * every screen that reads this map has to answer for all four tiers. The
 * assertion is unavoidable — Object.fromEntries is typed to lose the key union
 * — but it is not an unchecked claim: core/tiers.ts asserts at compile time
 * that TIERS lists every member of `Tier`, so the keys this produces are
 * exactly the keys the type promises.
 */
const emptyModels = (): TierRecord<string> =>
  Object.fromEntries(TIERS.map((t) => [t, ''])) as TierRecord<string>

function Frame({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          swisscode
        </Text>
        <Text dimColor>  ·  esc to cancel</Text>
      </Box>
      {children}
    </Box>
  )
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <Box>
      <Box width={12}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text dimColor={!!dim}>{value}</Text>
    </Box>
  )
}

type SummaryProps = {
  provider: ProviderDescriptor | null
  baseUrl?: string
  apiKey?: string
  models?: TierRecord<string>
}

function Summary({ provider, baseUrl, apiKey, models }: SummaryProps) {
  if (!provider) return null
  const url = provider.askBaseUrl ? baseUrl : provider.baseUrl
  const anyModel = models && TIERS.some((t) => models[t])
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Row label="provider" value={provider.label} />
      {url ? <Row label="endpoint" value={url} /> : null}
      {apiKey ? <Row label="key" value={mask(apiKey)} /> : null}
      {anyModel ? (
        <Row label="models" value={TIERS.map((t) => models[t] || '—').join('  /  ')} />
      ) : null}
    </Box>
  )
}

function profileNameFor(state: State, providerId: string | null): string {
  const current = state?.defaultProfile
  if (current && state?.profiles?.[current]) return current
  // `providerId!` is provable rather than hopeful: NAME_RE requires at least
  // one character, so it cannot match the '' that a null providerId falls back
  // to. A passing test therefore implies providerId is a non-empty string, and
  // the return type can be `string` — which is what lets the profile name reach
  // a computed key in finish() without an assertion of its own.
  return NAME_RE.test(providerId ?? '') ? providerId! : 'default'
}

/** cwd as a bindings key, or null when the directory is gone. */
function safeCwdKey(): string | null {
  try {
    return normalizeBindingKey(process.cwd())
  } catch {
    return null
  }
}

/** `setup` is the first-run path; `config` is every later edit. */
export type AppMode = 'config' | 'setup'

/**
 * Every screen the wizard can be on.
 *
 * A closed union, so a typo'd `setStep('modles')` is a compile error instead of
 * a screen that silently falls through to the permissions step. Note `perms`
 * has no `if` of its own — it is the final fallthrough render at the bottom of
 * the component — but it is still a step the machine sets and so belongs here.
 */
type Step =
  | 'profiles'
  | 'profileActions'
  | 'confirmDelete'
  | 'name'
  | 'provider'
  | 'baseUrl'
  | 'apiKey'
  | 'picker'
  | 'models'
  | 'perms'
  | 'saveError'

export type AppProps = {
  mode?: AppMode | undefined
  /** pre-loaded config document; null means read it from the store */
  state?: State | null | undefined
  /**
   * The profile to open the form with. `undefined` and `null` are DIFFERENT
   * here: undefined means "nothing was supplied, work it out", null means
   * "explicitly start blank". The component branches on `initial !== undefined`.
   */
  initial?: Profile | null | undefined
  profileName?: string | null | undefined
  /** called exactly once, with the saved profile or null if cancelled */
  onResult: (profile: Profile | null) => void
  store?: ConfigStorePort | null | undefined
  registry?: ProviderRegistryPort | undefined
  catalogs?: CatalogRegistryPort | null | undefined
  /** bindings key for the cwd; `undefined` means derive it, null means none */
  cwd?: string | null | undefined
}

export function App({
  mode = 'config',
  state = null,
  initial = undefined,
  profileName = null,
  onResult,
  store = null,
  registry = defaultRegistry,
  catalogs = null,
  cwd = undefined,
}: AppProps) {
  const { exit } = useApp()

  const configStore = useMemo(() => store ?? createFsConfigStore(), [store])
  const loadedState = useMemo(
    () => state ?? configStore.load().state,
    [state, configStore],
  )
  const catalogRegistry = useMemo(
    () =>
      catalogs ??
      createCatalogRegistry({
        net: fetchNet,
        clock: systemClock,
        cache: createFsCacheStore({ clock: systemClock }),
      }),
    [catalogs],
  )
  const cwdKey = useMemo(() => (cwd === undefined ? safeCwdKey() : cwd), [cwd])

  // The whole config document, edited in memory and written on save. Profile
  // management (default, delete, bind) mutates this; the form below edits one
  // profile inside it.
  const [doc, setDoc] = useState(loadedState)

  // Which profile the form is editing. `config <name>` names it up front; the
  // picker sets it; a first run derives it from the provider at save time.
  const names = Object.keys(loadedState.profiles ?? {})
  // `names[0]!` is the length === 1 guard on the line above meeting
  // noUncheckedIndexedAccess. Asserting here rather than downstream keeps
  // `openDirectly` a plain `string | null`, which is what the profile lookup
  // and `editingName` both want.
  const openDirectly =
    profileName ??
    (initial !== undefined
      ? null
      : names.length === 1
        ? names[0]!
        : (loadedState.defaultProfile ?? null))

  // `openDirectly as string` is NOT a provable invariant — `openDirectly` is
  // genuinely null whenever there is no default profile and more than one
  // profile exists. The code relies on `profiles[null]` returning undefined.
  //
  // Known bug: `obj[null]` coerces the key to the string "null", a legal
  // profile name (matches NAME_RE; not in SOFT_RESERVED or COMMON_WORD_GUARD).
  // A user with a profile named `null` and no default has that profile silently
  // loaded here, while `editingName` stays null and finish() saves under a
  // DIFFERENT, derived name.
  const startProfile =
    profileName !== null
      ? (loadedState.profiles?.[profileName] ?? null)
      : initial !== undefined
        ? initial
        : (loadedState.profiles?.[openDirectly as string] ?? null)

  // More than one profile and no particular one named: choose first. With
  // exactly one, open it directly — that is the pre-profiles behaviour and
  // nobody should pay a keystroke to pick from a list of one.
  const startStep =
    mode !== 'setup' && profileName === null && initial === undefined && names.length > 1
      ? 'profiles'
      : 'provider'

  const [step, setStep] = useState<Step>(startStep)
  const [editingName, setEditingName] = useState<string | null>(profileName ?? openDirectly)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [providerId, setProviderId] = useState<string | null>(startProfile?.provider ?? null)
  const [baseUrl, setBaseUrl] = useState(startProfile?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(startProfile?.apiKey ?? '')
  const [models, setModels] = useState<TierRecord<string>>({
    ...emptyModels(),
    ...(startProfile?.models ?? {}),
  })
  const [contextWindows, setContextWindows] = useState<Record<string, number>>({
    ...(startProfile?.contextWindows ?? {}),
  })
  const [tier, setTier] = useState(0)
  const [pickingTier, setPickingTier] = useState<Tier | null>(null)
  // `undefined` is in this type deliberately: a throw carrying no `.message`
  // stores undefined. Ink renders undefined and null identically (nothing).
  const [saveError, setSaveError] = useState<string | null | undefined>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const providers = registry.all()
  const provider = registry.byId(providerId)
  const catalog = provider?.catalogId ? catalogRegistry.byId(provider.catalogId) : null

  // The picker installs its own useInput and promises "esc back" in its
  // footer. Without this gate, esc fired BOTH handlers: the picker returned to
  // the tier list and this one tore the whole wizard down underneath it.
  const childOwnsInput = step === 'picker'

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        onResult(null)
        exit()
      }
    },
    { isActive: !childOwnsInput && step !== 'saveError' },
  )

  useInput(
    () => {
      onResult(null)
      exit()
    },
    { isActive: step === 'saveError' },
  )

  /** Every write goes through here so a failure can never escape into Ink. */
  const persist = (next: State, message?: string): boolean => {
    try {
      configStore.save(next)
    } catch (err) {
      // Property read, not `instanceof Error` / `String(err)`: a throw with no
      // `.message` yields `undefined` on screen; String(err) would show something
      // else. That is why `saveError` admits undefined.
      setSaveError((err as { message?: string }).message)
      setStep('saveError')
      return false
    }
    setDoc(next)
    if (message) setNotice(message)
    return true
  }

  const loadProfileIntoForm = (name: string) => {
    const p = doc.profiles?.[name] ?? null
    setEditingName(name)
    setProviderId(p?.provider ?? null)
    setBaseUrl(p?.baseUrl ?? '')
    setApiKey(p?.apiKey ?? '')
    setModels({ ...emptyModels(), ...(p?.models ?? {}) })
    setContextWindows({ ...(p?.contextWindows ?? {}) })
    setTier(0)
    setStep('provider')
  }

  const profileAction = (action: ProfileAction) => {
    // STEP-MACHINE INVARIANT: reachable only from <ProfileActions> at step
    // 'profileActions', entered only from the picker's onPick(name) — so
    // `editingName` is set. The types cannot see that step/`editingName`
    // correlation; the assertion covers every use below without a step-state
    // discriminated union.
    const name = editingName as string
    if (action === 'back' || action === 'noop') return setStep('profiles')
    if (action === 'edit') return loadProfileIntoForm(name)

    if (action === 'default') {
      persist({ ...doc, defaultProfile: name }, `"${name}" is now the default profile.`)
      return setStep('profiles')
    }
    if (action === 'bind') {
      // Same class of invariant as `name` above: <ProfileActions> only offers
      // bind/unbind when `cwd` is truthy, so cwdKey is set whenever these two
      // actions can fire. Unlike ProviderRegistryPort.byId, bindPath is not
      // implemented to MEAN anything by a null path — it would report
      // '"null" is not an absolute path', an error written for a bad string —
      // so widening its signature would be inventing a contract rather than
      // writing down an existing one.
      const result = bindPath(doc, cwdKey as string, name)
      if (!result.ok) {
        setNotice(result.reason)
        return setStep('profiles')
      }
      persist(result.state, `${result.key} now uses "${name}".`)
      return setStep('profiles')
    }
    if (action === 'unbind') {
      const result = unbindPath(doc, cwdKey as string)
      persist(result.state, `${result.key} is no longer bound.`)
      return setStep('profiles')
    }
    if (action === 'delete') return setStep('confirmDelete')
    return setStep('profiles')
  }

  const deleteProfile = () => {
    // Same step-machine invariant as profileAction: reached only from
    // <ConfirmDelete> at step 'confirmDelete', which profileAction('delete')
    // enters with `editingName` already set.
    const name = editingName as string
    const profiles = { ...(doc.profiles ?? {}) }
    delete profiles[name]
    // A binding to a deleted profile is inert but confusing; take them with it.
    const pruned = pruneBindingsForProfile({ ...doc, profiles }, name)
    const next = pruned.state
    if (next.defaultProfile === name) {
      const remaining = Object.keys(profiles)
      // One left is unambiguous; several is not, and guessing picks an account
      // to bill.
      //
      // `remaining[0]!` meets noUncheckedIndexedAccess: the branch is guarded
      // on length === 1.
      next.defaultProfile = remaining.length === 1 ? remaining[0]! : null
    }
    if (!persist(next, `Deleted "${name}".`)) return
    if (Object.keys(profiles).length === 0) {
      onResult(null)
      return exit()
    }
    setEditingName(null)
    setStep('profiles')
  }

  const chooseProvider = (id: string) => {
    setProviderId(id)
    // Keep hand-edited models when re-configuring the same provider; otherwise
    // start from that provider's defaults. Compared against the profile
    // currently loaded in the form, which is not necessarily the one this
    // wizard opened with.
    const stored = editingName ? doc.profiles?.[editingName] : startProfile
    // `byId(id)!` — `id` is the `value` of an item built from `registry.all()`
    // a few lines below, so it always names a shipped descriptor. This is the
    // one lookup in the file that genuinely cannot miss; everywhere else byId
    // returning null is a real answer the code handles.
    setModels(
      stored?.provider === id && stored?.models
        ? { ...emptyModels(), ...stored.models }
        : { ...emptyModels(), ...registry.byId(id)!.defaultModels },
    )
    if (registry.byId(id)!.askBaseUrl) setStep('baseUrl')
    else setStep('apiKey')
  }

  const finish = (skipPermissions: boolean) => {
    // Keep only the windows for models this profile actually uses, so the map
    // cannot grow without bound as someone browses the catalog.
    const inUse = new Set(TIERS.map((t) => models[t]).filter(Boolean))
    const keptWindows = Object.fromEntries(
      Object.entries(contextWindows).filter(([id]) => inUse.has(id)),
    )
    // Annotated `Profile` rather than inferred, so this object is checked
    // against the config schema HERE — at the one place in the wizard that
    // mints a profile — instead of only wherever it happens to be consumed.
    //
    // STEP-MACHINE INVARIANT (`providerId!`, `provider!`): finish() runs only
    // from the permissions screen, which is reachable only via the models step,
    // which is reachable only via chooseProvider(). Both are set.
    const profile: Profile = {
      provider: providerId!,
      ...(provider!.askBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
      apiKey: apiKey.trim(),
      models,
      ...(Object.keys(keptWindows).length > 0 ? { contextWindows: keptWindows } : {}),
      skipPermissions,
    }
    // An explicitly named profile keeps its name; a first run derives one from
    // the provider, exactly as before profiles existed.
    const name = editingName ?? profileNameFor(doc, providerId)
    const next = {
      ...doc,
      profiles: { ...(doc.profiles ?? {}), [name]: profile },
      defaultProfile: doc.defaultProfile ?? name,
    }

    // A throw here would escape an Ink input handler with the tty still in raw
    // mode, leaving the terminal unusable. Surface it in-frame instead.
    if (!persist(next)) return
    onResult(profile)
    exit()
  }

  if (step === 'saveError') {
    return (
      <Frame>
        <Text color="red">Could not save your configuration.</Text>
        <Text dimColor>{saveError}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press any key to close. Nothing was launched.</Text>
        </Box>
      </Frame>
    )
  }

  if (step === 'profiles') {
    return (
      <Frame>
        {notice ? <Text color="green">{notice}</Text> : null}
        <ProfilePicker
          state={doc}
          onPick={(name) => {
            setNotice(null)
            setEditingName(name)
            setStep('profileActions')
          }}
          onNew={() => {
            setNotice(null)
            setNewName('')
            setNameError(null)
            setStep('name')
          }}
        />
      </Frame>
    )
  }

  if (step === 'profileActions') {
    return (
      <Frame>
        <ProfileActions name={editingName} state={doc} cwd={cwdKey} onAction={profileAction} />
      </Frame>
    )
  }

  if (step === 'confirmDelete') {
    const bound = Object.entries(doc.bindings ?? {})
      .filter(([, v]) => (typeof v === 'string' ? v : v?.profile) === editingName)
      .map(([k]) => k)
    return (
      <Frame>
        <ConfirmDelete
          name={editingName}
          bindings={bound}
          onConfirm={deleteProfile}
          onCancel={() => setStep('profileActions')}
        />
      </Frame>
    )
  }

  if (step === 'name') {
    const submit = () => {
      const candidate = newName.trim()
      if (Object.prototype.hasOwnProperty.call(doc.profiles ?? {}, candidate)) {
        setNameError(`"${candidate}" already exists.`)
        return
      }
      // Validation applies at CREATION only, never at parse: a hand-edited
      // config keeps working whatever it contains.
      const verdict = validateProfileName(candidate)
      if (!verdict.ok) {
        setNameError(verdict.reason)
        return
      }
      setEditingName(candidate)
      setProviderId(null)
      setBaseUrl('')
      setApiKey('')
      setModels(emptyModels())
      setContextWindows({})
      setTier(0)
      setStep('provider')
    }
    return (
      <Frame>
        <Text>Name for the new profile:</Text>
        <Text dimColor>
          `swisscode {newName.trim() || '<name>'}` in any directory will use it.
        </Text>
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={newName}
            onChange={(v) => {
              setNewName(v)
              setNameError(null)
            }}
            placeholder="work"
            onSubmit={submit}
          />
        </Box>
        {nameError ? <Text color="red">{nameError}</Text> : null}
      </Frame>
    )
  }

  if (step === 'provider') {
    const items = providers.map((p) => ({ label: p.label, value: p.id }))
    const index = Math.max(0, providers.findIndex((p) => p.id === providerId))
    return (
      <Frame>
        {editingName ? <Text dimColor>profile: {editingName}</Text> : null}
        <Text>Which provider should Claude Code talk to?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            initialIndex={index}
            onSelect={(item) => chooseProvider(item.value)}
          />
        </Box>
      </Frame>
    )
  }

  if (step === 'baseUrl') {
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} models={models} />
        <Text>Base URL for the Anthropic-compatible endpoint:</Text>
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://…"
            onSubmit={() => baseUrl.trim() && setStep('apiKey')}
          />
        </Box>
      </Frame>
    )
  }

  if (step === 'apiKey') {
    // STEP-MACHINE INVARIANT for every `provider!` below: this screen is
    // reachable only through chooseProvider(), which sets providerId to an id
    // taken from registry.all(). `Summary` still takes the nullable value —
    // it is written to handle null and returns nothing for it.
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} models={models} />
        <Text>
          API key <Text dimColor>({provider!.credentialEnv})</Text>
        </Text>
        {provider!.hints?.keyHint ? <Text dimColor>{provider!.hints.keyHint}</Text> : null}
        {provider!.hints?.note ? <Text dimColor>{provider!.hints.note}</Text> : null}
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            mask="•"
            placeholder={provider!.credentialOptional ? 'optional' : 'paste key'}
            onSubmit={() => {
              if (apiKey.trim() || provider!.credentialOptional) setStep('models')
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>stored at ~/.config/swisscode/config.json (chmod 600)</Text>
        </Box>
      </Frame>
    )
  }

  if (step === 'picker') {
    // STEP-MACHINE INVARIANT (`pickingTier!`, `catalog!`): this step is entered
    // from exactly one place — the tier list below, which exists only in the
    // `step === 'models' && catalog` branch and always calls setPickingTier
    // before setStep('picker').
    return (
      <Frame>
        <ModelPicker
          tier={pickingTier}
          current={models[pickingTier!]}
          catalog={catalog!}
          onSelect={(model) => {
            setModels((m) => ({ ...m, [pickingTier!]: model.id }))
            // Record the catalog's published context_length alongside the id.
            // This is the only measured window we get, and it is what lets the
            // launch set an auto-compact window without guessing.
            //
            // `model.context!` twice: `context` is `number | null` because
            // ModelScope publishes none, and Number.isFinite is not a type
            // guard — but it is a real runtime one, and a null cannot reach
            // either use past it.
            if (Number.isFinite(model.context) && model.context! > 0) {
              setContextWindows((c) => ({ ...c, [model.id]: model.context! }))
            }
            setStep('models')
          }}
          onCancel={() => setStep('models')}
        />
      </Frame>
    )
  }

  // Providers with a queryable catalog get a browsable picker per tier;
  // everything else falls through to typing the model id by hand.
  if (step === 'models' && catalog) {
    // Annotated so `value` keeps its union instead of widening to `string`.
    // That is what makes the `=== '__done'` test below a real narrowing: after
    // the early return, `item.value` is a `Tier` and setPickingTier accepts it
    // with no assertion. Widened to `string` it would have needed one.
    const items: Array<{ label: string; value: Tier | '__done' }> = [
      ...TIERS.map((t) => ({
        label: `${t.padEnd(7)} ${models[t] || '—'}`,
        value: t,
      })),
      { label: 'continue →', value: '__done' },
    ]
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} />
        <Text>Pick a model per tier <Text dimColor>· enter to browse</Text></Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === '__done') return setStep('perms')
              setPickingTier(item.value)
              setStep('picker')
            }}
          />
        </Box>
      </Frame>
    )
  }

  if (step === 'models') {
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} />
        <Text>Model for each tier <Text dimColor>· enter to advance</Text></Text>
        {/* `provider!` — same step-machine invariant as the apiKey screen. */}
        {provider!.hints?.modelHint ? <Text dimColor>{provider!.hints.modelHint}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {TIERS.map((t, i) => (
            <Box key={t}>
              <Box width={9}>
                <Text {...(i === tier ? { color: 'cyan' as const } : {})} dimColor={i !== tier}>
                  {i === tier ? '› ' : '  '}
                  {t}
                </Text>
              </Box>
              <TextInput
                value={models[t]}
                focus={i === tier}
                showCursor={i === tier}
                placeholder="—"
                onChange={(v) => setModels((m) => ({ ...m, [t]: v }))}
                onSubmit={() => (i === TIERS.length - 1 ? setStep('perms') : setTier(i + 1))}
              />
            </Box>
          ))}
        </Box>
      </Frame>
    )
  }

  return (
    <Frame>
      <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} models={models} />
      <Text>Pass --dangerously-skip-permissions by default?</Text>
      <Text dimColor>override per run with --safe or --yolo</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'yes — skip permission prompts', value: true },
            { label: 'no  — prompt as normal', value: false },
          ]}
          initialIndex={startProfile?.skipPermissions === false ? 1 : 0}
          onSelect={(item) => finish(item.value)}
        />
      </Box>
    </Frame>
  )
}

/**
 * What `src/cli.ts` may hand the wizard. A strict subset of `AppProps`: the
 * adapters (store, registry, catalogs) are the component's own defaults here,
 * and only tests substitute them.
 */
export type RunUiOptions = {
  mode?: AppMode | undefined
  state?: State | null | undefined
  initial?: Profile | null | undefined
  profileName?: string | null | undefined
}

export async function runUi({
  mode = 'config',
  state = null,
  initial = undefined,
  profileName = null,
}: RunUiOptions = {}) {
  let result: Profile | null = null
  const app = render(
    <App
      mode={mode}
      state={state}
      initial={initial}
      profileName={profileName}
      onResult={(cfg) => {
        result = cfg
      }}
    />,
    { exitOnCtrlC: false },
  )
  // Waiting for a full unmount matters: Ink has to restore the terminal (raw
  // mode, cursor) before we hand the tty over to Claude Code.
  await app.waitUntilExit()
  return result
}
