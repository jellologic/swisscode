import React from 'react'
import { Box, Text } from 'ink'
import SelectInput from 'ink-select-input'
import { TIERS } from '../../core/tiers.js'

/**
 * Presence and ORIGIN of the credential, never any part of the value.
 * A masked key still leaks its length, and this screen gets screen-shared.
 */
function credentialLabel(profile) {
  if (profile?.apiKeyFromEnv) return `key from $${profile.apiKeyFromEnv}`
  if (profile?.apiKey) return 'key stored'
  return 'no key'
}

function summarize(profile, boundPaths) {
  const models = TIERS.map((t) => profile?.models?.[t]).filter(Boolean)
  const distinct = [...new Set(models)]
  const modelLabel =
    distinct.length === 0
      ? 'no models pinned'
      : distinct.length === 1
        ? distinct[0]
        : `${distinct.length} models`
  const bits = [profile?.provider ?? '?', modelLabel, credentialLabel(profile)]
  if (boundPaths > 0) bits.push(`${boundPaths} binding${boundPaths === 1 ? '' : 's'}`)
  return bits.join('  ·  ')
}

/**
 * The profile list. Opens only when more than one profile exists — with exactly
 * one, `cuckoocode config` goes straight into editing it, which is the
 * behaviour people had before profiles existed and there is no reason to make
 * them pay a keystroke for a choice of one.
 */
export function ProfilePicker({ state, onPick, onNew }) {
  const names = Object.keys(state.profiles ?? {}).sort()
  const bindingCounts = new Map()
  for (const value of Object.values(state.bindings ?? {})) {
    const name = typeof value === 'string' ? value : value?.profile
    if (name) bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1)
  }

  const items = [
    ...names.map((name) => ({
      label: `${state.defaultProfile === name ? '★' : ' '} ${name}`,
      value: name,
    })),
    { label: '  + new profile', value: '__new' },
  ]

  return (
    <Box flexDirection="column">
      <Text>Profiles <Text dimColor>· ★ is the default · enter to open</Text></Text>
      <Box flexDirection="column" marginTop={1}>
        {names.map((name) => (
          <Box key={name}>
            <Box width={18}>
              <Text dimColor>{name}</Text>
            </Box>
            <Text dimColor>{summarize(state.profiles[name], bindingCounts.get(name) ?? 0)}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => (item.value === '__new' ? onNew() : onPick(item.value))}
        />
      </Box>
    </Box>
  )
}

/** What you can do to the profile you just selected. */
export function ProfileActions({ name, state, cwd, onAction }) {
  const isDefault = state.defaultProfile === name
  const boundHere = cwd ? state.bindings?.[cwd] === name : false

  const items = [
    { label: `edit "${name}"`, value: 'edit' },
    isDefault
      ? { label: 'already the default profile', value: 'noop' }
      : { label: 'make this the default profile', value: 'default' },
    cwd
      ? {
          label: boundHere
            ? `unbind this directory (${cwd})`
            : `use "${name}" in this directory (${cwd})`,
          value: boundHere ? 'unbind' : 'bind',
        }
      : null,
    { label: `delete "${name}"`, value: 'delete' },
    { label: '← back', value: 'back' },
  ].filter(Boolean)

  return (
    <Box flexDirection="column">
      <Text>
        Profile <Text bold color="cyan">{name}</Text>
      </Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onAction(item.value)} />
      </Box>
    </Box>
  )
}

/**
 * Deletion asks. Everything else in this wizard is reversible by re-running it;
 * this one throws away a key the user may not have anywhere else.
 */
export function ConfirmDelete({ name, bindings, onConfirm, onCancel }) {
  return (
    <Box flexDirection="column">
      <Text color="red">Delete profile "{name}"?</Text>
      <Text dimColor>Its API key is removed from config.json and cannot be recovered.</Text>
      {bindings.length > 0 ? (
        <Text dimColor>
          {bindings.length} directory binding{bindings.length === 1 ? '' : 's'} will be removed too.
        </Text>
      ) : null}
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'no — keep it', value: false },
            { label: `yes — delete "${name}"`, value: true },
          ]}
          onSelect={(item) => (item.value ? onConfirm() : onCancel())}
        />
      </Box>
    </Box>
  )
}
