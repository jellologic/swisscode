import React, { useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import { TIERS } from '../../core/tiers.js'
import { NAME_RE, validateProfileName } from '../../core/migrate.js'
import { bindPath, normalizeBindingKey, pruneBindingsForProfile, unbindPath } from '../../core/binding.js'
import { registry as defaultRegistry } from '../providers/registry.js'
import { createFsConfigStore } from '../store/fs-config-store.js'
import { createFsCacheStore } from '../store/fs-cache-store.js'
import { createCatalogRegistry } from '../catalog/registry.js'
import { fetchNet } from '../net/fetch-net.js'
import { systemClock } from '../clock/system-clock.js'
import { ModelPicker } from './ModelPicker.jsx'
import { ConfirmDelete, ProfileActions, ProfilePicker } from './ProfilePicker.jsx'

export { ModelPicker, ProfilePicker }

const mask = (s) => (s ? '•'.repeat(Math.min(s.length, 24)) : '')
const emptyModels = () => Object.fromEntries(TIERS.map((t) => [t, '']))

function Frame({ children }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          cuckoocode
        </Text>
        <Text dimColor>  ·  esc to cancel</Text>
      </Box>
      {children}
    </Box>
  )
}

function Row({ label, value, dim }) {
  return (
    <Box>
      <Box width={12}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text dimColor={dim}>{value}</Text>
    </Box>
  )
}

function Summary({ provider, baseUrl, apiKey, models }) {
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

function profileNameFor(state, providerId) {
  const current = state?.defaultProfile
  if (current && state?.profiles?.[current]) return current
  return NAME_RE.test(providerId ?? '') ? providerId : 'default'
}

/** cwd as a bindings key, or null when the directory is gone. */
function safeCwdKey() {
  try {
    return normalizeBindingKey(process.cwd())
  } catch {
    return null
  }
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
}) {
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
  const openDirectly =
    profileName ??
    (initial !== undefined
      ? null
      : names.length === 1
        ? names[0]
        : (loadedState.defaultProfile ?? null))

  const startProfile =
    profileName !== null
      ? (loadedState.profiles?.[profileName] ?? null)
      : initial !== undefined
        ? initial
        : (loadedState.profiles?.[openDirectly] ?? null)

  // More than one profile and no particular one named: choose first. With
  // exactly one, open it directly — that is the pre-profiles behaviour and
  // nobody should pay a keystroke to pick from a list of one.
  const startStep =
    mode !== 'setup' && profileName === null && initial === undefined && names.length > 1
      ? 'profiles'
      : 'provider'

  const [step, setStep] = useState(startStep)
  const [editingName, setEditingName] = useState(profileName ?? openDirectly)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState(null)
  const [providerId, setProviderId] = useState(startProfile?.provider ?? null)
  const [baseUrl, setBaseUrl] = useState(startProfile?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(startProfile?.apiKey ?? '')
  const [models, setModels] = useState({ ...emptyModels(), ...(startProfile?.models ?? {}) })
  const [contextWindows, setContextWindows] = useState({ ...(startProfile?.contextWindows ?? {}) })
  const [tier, setTier] = useState(0)
  const [pickingTier, setPickingTier] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [notice, setNotice] = useState(null)

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
  const persist = (next, message) => {
    try {
      configStore.save(next)
    } catch (err) {
      setSaveError(err.message)
      setStep('saveError')
      return false
    }
    setDoc(next)
    if (message) setNotice(message)
    return true
  }

  const loadProfileIntoForm = (name) => {
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

  const profileAction = (action) => {
    const name = editingName
    if (action === 'back' || action === 'noop') return setStep('profiles')
    if (action === 'edit') return loadProfileIntoForm(name)

    if (action === 'default') {
      persist({ ...doc, defaultProfile: name }, `"${name}" is now the default profile.`)
      return setStep('profiles')
    }
    if (action === 'bind') {
      const result = bindPath(doc, cwdKey, name)
      if (!result.ok) {
        setNotice(result.reason)
        return setStep('profiles')
      }
      persist(result.state, `${result.key} now uses "${name}".`)
      return setStep('profiles')
    }
    if (action === 'unbind') {
      const result = unbindPath(doc, cwdKey)
      persist(result.state, `${result.key} is no longer bound.`)
      return setStep('profiles')
    }
    if (action === 'delete') return setStep('confirmDelete')
    return setStep('profiles')
  }

  const deleteProfile = () => {
    const name = editingName
    const profiles = { ...(doc.profiles ?? {}) }
    delete profiles[name]
    // A binding to a deleted profile is inert but confusing; take them with it.
    const pruned = pruneBindingsForProfile({ ...doc, profiles }, name)
    const next = pruned.state
    if (next.defaultProfile === name) {
      const remaining = Object.keys(profiles)
      // One left is unambiguous; several is not, and guessing picks an account
      // to bill.
      next.defaultProfile = remaining.length === 1 ? remaining[0] : null
    }
    if (!persist(next, `Deleted "${name}".`)) return
    if (Object.keys(profiles).length === 0) {
      onResult(null)
      return exit()
    }
    setEditingName(null)
    setStep('profiles')
  }

  const chooseProvider = (id) => {
    setProviderId(id)
    // Keep hand-edited models when re-configuring the same provider; otherwise
    // start from that provider's defaults. Compared against the profile
    // currently loaded in the form, which is not necessarily the one this
    // wizard opened with.
    const stored = editingName ? doc.profiles?.[editingName] : startProfile
    setModels(
      stored?.provider === id && stored?.models
        ? { ...emptyModels(), ...stored.models }
        : { ...emptyModels(), ...registry.byId(id).defaultModels },
    )
    if (registry.byId(id).askBaseUrl) setStep('baseUrl')
    else setStep('apiKey')
  }

  const finish = (skipPermissions) => {
    // Keep only the windows for models this profile actually uses, so the map
    // cannot grow without bound as someone browses the catalog.
    const inUse = new Set(TIERS.map((t) => models[t]).filter(Boolean))
    const keptWindows = Object.fromEntries(
      Object.entries(contextWindows).filter(([id]) => inUse.has(id)),
    )
    const profile = {
      provider: providerId,
      ...(provider.askBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
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
          `cuckoocode {newName.trim() || '<name>'}` in any directory will use it.
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
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} models={models} />
        <Text>
          API key <Text dimColor>({provider.credentialEnv})</Text>
        </Text>
        {provider.hints?.keyHint ? <Text dimColor>{provider.hints.keyHint}</Text> : null}
        {provider.hints?.note ? <Text dimColor>{provider.hints.note}</Text> : null}
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            mask="•"
            placeholder={provider.credentialOptional ? 'optional' : 'paste key'}
            onSubmit={() => {
              if (apiKey.trim() || provider.credentialOptional) setStep('models')
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>stored at ~/.config/cuckoocode/config.json (chmod 600)</Text>
        </Box>
      </Frame>
    )
  }

  if (step === 'picker') {
    return (
      <Frame>
        <ModelPicker
          tier={pickingTier}
          current={models[pickingTier]}
          catalog={catalog}
          onSelect={(model) => {
            setModels((m) => ({ ...m, [pickingTier]: model.id }))
            // Record the catalog's published context_length alongside the id.
            // This is the only measured window we get, and it is what lets the
            // launch set an auto-compact window without guessing.
            if (Number.isFinite(model.context) && model.context > 0) {
              setContextWindows((c) => ({ ...c, [model.id]: model.context }))
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
    const items = [
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
        {provider.hints?.modelHint ? <Text dimColor>{provider.hints.modelHint}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {TIERS.map((t, i) => (
            <Box key={t}>
              <Box width={9}>
                <Text color={i === tier ? 'cyan' : undefined} dimColor={i !== tier}>
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

export async function runUi({
  mode = 'config',
  state = null,
  initial = undefined,
  profileName = null,
} = {}) {
  let result = null
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
