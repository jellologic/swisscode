import React from 'react'
import { Box, Text } from 'ink'
import SelectInput from 'ink-select-input'
import { TIERS } from '../../core/tiers.ts'
import { resolveProfileRefs } from '../../core/resolve.ts'
import type { ResolvedProfile, State } from '../../ports/config-store.ts'

/**
 * Presence and ORIGIN of the credential, never any part of the value.
 * A masked key still leaks its length, and this screen gets screen-shared.
 */
function credentialLabel(profile: ResolvedProfile | undefined): string {
  if (profile?.apiKeyFromEnv) return `key from $${profile.apiKeyFromEnv}`
  if (profile?.apiKey) return 'key stored'
  return 'no key'
}

/**
 * The flattened view of a profile, or undefined when it cannot be resolved.
 *
 * A profile with a dangling reference still LISTS — it summarises as blank
 * rather than vanishing, because this screen is how you reach the editor that
 * repairs it.
 */
function resolvedOrUndefined(state: State, name: string): ResolvedProfile | undefined {
  const r = resolveProfileRefs(state, name)
  return r.ok ? r.resolved : undefined
}

function summarize(profile: ResolvedProfile | undefined, boundPaths: number): string {
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

export type ProfilePickerProps = {
  state: State
  onPick: (name: string) => void
  onNew: () => void
}

/**
 * The profile list. Opens only when more than one profile exists — with exactly
 * one, `swisscode config` goes straight into editing it, which is the
 * behaviour people had before profiles existed and there is no reason to make
 * them pay a keystroke for a choice of one.
 */
export function ProfilePicker({ state, onPick, onNew }: ProfilePickerProps) {
  const names = Object.keys(state.profiles ?? {}).sort()
  const bindingCounts = new Map<string, number>()
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
            <Text dimColor>
              {summarize(resolvedOrUndefined(state, name), bindingCounts.get(name) ?? 0)}
            </Text>
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

/**
 * Every action this screen can emit. Exhaustive on purpose: index.tsx's
 * `profileAction` switches on exactly these, so adding an entry here without
 * handling it there is a compile error rather than a menu item that does
 * nothing.
 */
export type ProfileAction = 'edit' | 'noop' | 'default' | 'bind' | 'unbind' | 'delete' | 'back'

type ActionItem = { label: string; value: ProfileAction }

export type ProfileActionsProps = {
  name: string | null
  state: State
  cwd: string | null
  onAction: (action: ProfileAction) => void
}

/** What you can do to the profile you just selected. */
export function ProfileActions({ name, state, cwd, onAction }: ProfileActionsProps) {
  const isDefault = state.defaultProfile === name
  // A BindingValue is `string | { profile; overrides? }`, so a raw `=== name`
  // is always false for the object form — which would offer "bind" and silently
  // overwrite an object binding, discarding its overrides. Extract the name the
  // same union-aware way `summarize` and `toEntry` do.
  const bound = cwd ? state.bindings?.[cwd] : undefined
  const boundName = typeof bound === 'string' ? bound : bound?.profile
  const boundHere = boundName === name

  // `satisfies` checks every entry's SHAPE (a typo'd action value fails here);
  // the assertion afterwards discharges only the nullability. filter(Boolean)
  // provably drops the nulls, but BooleanConstructor carries no type predicate,
  // so tsc cannot see it.
  const items = (
    [
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
    ] satisfies Array<ActionItem | null>
  ).filter(Boolean) as ActionItem[]

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

export type ConfirmDeleteProps = {
  name: string | null
  /** binding keys that point at this profile and will go with it */
  bindings: string[]
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Deletion asks. Everything else in this wizard is reversible by re-running it;
 * this one throws away a key the user may not have anywhere else.
 */
export function ConfirmDelete({ name, bindings, onConfirm, onCancel }: ConfirmDeleteProps) {
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
