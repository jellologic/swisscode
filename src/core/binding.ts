// Directory -> profile bindings.
//
// The bindings map arrives inside the config JSON that is already being read,
// so the "walk" is string arithmetic on path components. No stat, no readdir,
// no realpath, no dotfile probing — ever, on the launch path. A user who never
// binds anything pays one property check.
//
// Zero RUNTIME imports on purpose: this is the launch path, and dirname on an
// already normalized absolute path is a lastIndexOf. The type imports below are
// erased entirely — test/architecture.test.js checks core's purity against the
// post-erasure graph, so this file still imports nothing at runtime.

import type { BindingValue, ProfileOverrides, Settings, State } from '../ports/config-store.ts'

export const DEFAULT_WALK_DEPTH = 40

const WIN_DRIVE = /^[A-Za-z]:$/

/**
 * A binding, flattened out of the string-or-object union that `BindingValue`
 * allows. Declared here rather than in the port because it is core's own
 * intermediate shape: nothing outside this module and its callers ever sees it,
 * and it is not part of the persisted schema.
 */
export type ResolvedBinding = {
  name: string
  key: string
  overrides?: ProfileOverrides
}

/** One stored binding, flattened and flagged, as `config bindings` lists them. */
export type BindingEntry = {
  key: string
  name: string | null
  overrides: ProfileOverrides | null
  dangling: boolean
}

export type PrunedBinding = BindingEntry & { reason: string }

/**
 * `Number.isInteger` does not coerce — it is false for every non-number,
 * including `undefined` — so this is the same runtime test, with the narrowing
 * the settings lookups below need. Without it, `settings.bindingWalkDepth`
 * after an `isInteger(settings?.bindingWalkDepth)` guard reads as possibly
 * undefined and the original expression does not compile.
 */
function isInteger(v: unknown): v is number {
  return Number.isInteger(v)
}

export function isAbsolutePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p[0] === '/') return true
  if (p.startsWith('\\\\')) return true // UNC
  return /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Normalize a path into the form used as a bindings key: absolute, no trailing
 * separator except at a root. Stored verbatim in the user's case — folding at
 * rest would be wrong on Linux.
 */
export function normalizeBindingKey(p: unknown): string | null {
  if (typeof p !== 'string') return null
  let s = p.trim()
  if (s.length === 0) return null
  if (!isAbsolutePath(s)) return null

  const unc = s.startsWith('\\\\')
  const win = unc || WIN_DRIVE.test(s.slice(0, 2))
  if (win) s = s.replace(/\//g, '\\')

  const sep = win ? '\\' : '/'
  const prefix = unc ? '\\\\' : ''
  const body = unc ? s.slice(2) : s

  const parts: string[] = []
  for (const part of body.split(win ? /\\+/ : /\/+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Never climb past the root component.
      if (parts.length > (win && !unc ? 1 : unc ? 2 : 0)) parts.pop()
      continue
    }
    parts.push(part)
  }

  if (unc) {
    // \\server\share is the shallowest addressable UNC path.
    if (parts.length < 2) return null
    return prefix + parts.join(sep)
  }
  if (win) {
    const drive = parts.shift()
    return parts.length === 0 ? `${drive}\\` : `${drive}\\${parts.join(sep)}`
  }
  return `/${parts.join(sep)}` === '/' ? '/' : `/${parts.join(sep)}`
}

/** Parent of a normalized key, or null once the root is reached. */
export function parentOf(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) return null

  if (key.startsWith('\\\\')) {
    const parts = key.slice(2).split('\\')
    if (parts.length <= 2) return null // \\server\share is the UNC root
    parts.pop()
    return `\\\\${parts.join('\\')}`
  }
  if (WIN_DRIVE.test(key.slice(0, 2))) {
    if (key.length <= 3) return null // "C:\"
    const parts = key.split('\\')
    parts.pop()
    return parts.length <= 1 ? `${parts[0]}\\` : parts.join('\\')
  }
  if (key === '/') return null
  const i = key.lastIndexOf('/')
  if (i <= 0) return '/'
  return key.slice(0, i)
}

function depthOf(key: string): number {
  let d = 0
  let cur: string | null = key
  while (cur != null) {
    const next = parentOf(cur)
    if (next === null) break
    cur = next
    d++
    if (d > 512) break
  }
  return d
}

/** Smallest depth among the binding keys — the walk can stop there. */
export function minBindingDepth(
  bindings: Record<string, BindingValue> | null | undefined,
): number | null {
  const keys = Object.keys(bindings ?? {})
  if (keys.length === 0) return null
  let min = Infinity
  for (const k of keys) min = Math.min(min, depthOf(k))
  return min
}

/**
 * Nearest-ancestor lookup. Longest prefix wins for free, because the walk
 * starts at the deepest path.
 *
 * Case sensitivity: the exact walk always runs first. Only on darwin/win32, and
 * only when it missed, is a lowercase index built and the walk repeated —
 * correct on Linux, and free on macOS whenever the exact match hits.
 */
export function resolveBinding(
  cwd: string | null | undefined,
  bindings: Record<string, BindingValue> | null | undefined,
  settings: Settings | null | undefined = {},
  platform: string = 'linux',
): ResolvedBinding | null {
  if (!bindings || typeof bindings !== 'object') return null
  const keys = Object.keys(bindings)
  if (keys.length === 0) return null // fast path: one property check

  const start = normalizeBindingKey(cwd)
  if (start === null) return null

  const floor = minBindingDepth(bindings) ?? 0
  const cap = isInteger(settings?.bindingWalkDepth) ? settings.bindingWalkDepth : DEFAULT_WALK_DEPTH
  const budget = Math.max(0, Math.min(depthOf(start) - floor, cap))

  const exact = walk(start, budget, (k) =>
    Object.prototype.hasOwnProperty.call(bindings, k) ? k : null,
  )
  if (exact) return toEntry(bindings[exact], exact)

  if (platform !== 'darwin' && platform !== 'win32') return null

  const folded = new Map<string, string>()
  for (const k of keys) {
    const lower = k.toLowerCase()
    if (!folded.has(lower)) folded.set(lower, k)
  }
  const hit = walk(start, budget, (k) => folded.get(k.toLowerCase()) ?? null)
  return hit ? toEntry(bindings[hit], hit) : null
}

function walk(
  start: string,
  budget: number,
  probe: (k: string) => string | null,
): string | null {
  let cur: string | null = start
  for (let i = 0; i <= budget && cur !== null; i++) {
    const hit = probe(cur)
    if (hit !== null) return hit
    const next = parentOf(cur)
    if (next === cur) break // belt and braces: POSIX root, C:\, UNC root
    cur = next
  }
  return null
}

/**
 * `BindingValue | undefined` rather than `unknown`: the store port declares
 * `bindings` as `Record<string, BindingValue>`, and `undefined` is what
 * `noUncheckedIndexedAccess` adds on every lookup. The `typeof value.profile`
 * check below is kept verbatim anyway — it is the runtime residue of not
 * trusting a hand-edited file, and returning null for junk is load-bearing:
 * `bindingEntries` reports exactly that as `dangling`.
 */
function toEntry(value: BindingValue | undefined, key: string): ResolvedBinding | null {
  if (typeof value === 'string') return { name: value, key }
  if (value && typeof value === 'object' && typeof value.profile === 'string') {
    // Accepted on read from day one so a later feature needs no version bump.
    return { name: value.profile, key, overrides: value.overrides }
  }
  return null
}

// ---------------------------------------------------------------------------
// Everything below is for `config use` / `bind` / `unbind` / `bindings`, not
// for the launch path. Still pure: state in, new state out. The adapter owns
// stat() and printing.
//
// Nothing here is reachable from a launch, so it costs a launch nothing — the
// module is already loaded for resolveBinding either way.
// ---------------------------------------------------------------------------

/**
 * The exact list of keys the walk would probe, deepest first. This is what
 * makes `config use --show` able to say WHERE it looked rather than just what
 * it found — a binding that silently does not apply is the whole failure mode.
 */
export function ancestorsOf(
  cwd: string | null | undefined,
  bindings: Record<string, BindingValue> | null | undefined,
  settings: Settings | null | undefined = {},
): string[] {
  // Mirrors resolveBinding's fast path: with no bindings stored, nothing is
  // searched at all, so reporting a walk to the filesystem root would describe
  // work that never happens.
  if (!bindings || Object.keys(bindings).length === 0) return []
  const start = normalizeBindingKey(cwd)
  if (start === null) return []
  const floor = minBindingDepth(bindings) ?? 0
  const cap = isInteger(settings?.bindingWalkDepth) ? settings.bindingWalkDepth : DEFAULT_WALK_DEPTH
  const budget = Math.max(0, Math.min(depthOf(start) - floor, cap))

  const out: string[] = []
  let cur: string | null = start
  for (let i = 0; i <= budget && cur !== null; i++) {
    out.push(cur)
    const next = parentOf(cur)
    if (next === cur) break
    cur = next
  }
  return out
}

/** Every stored binding, flattened and flagged. Sorted for stable output. */
export function bindingEntries(state: State): BindingEntry[] {
  const profiles = state?.profiles ?? {}
  return Object.entries(state?.bindings ?? {})
    .map(([key, value]) => {
      const entry = toEntry(value, key)
      return {
        key,
        name: entry?.name ?? null,
        overrides: entry?.overrides ?? null,
        // A binding whose profile was deleted is inert, not fatal: resolution
        // warns once and falls through to the default.
        dangling: entry === null || !Object.prototype.hasOwnProperty.call(profiles, entry.name),
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Bind a directory to a profile. */
export function bindPath(
  state: State,
  path: string,
  profileName: string,
):
  | { ok: true; state: State; key: string; replaced: string | null }
  | { ok: false; reason: string } {
  const key = normalizeBindingKey(path)
  if (key === null) {
    return { ok: false, reason: `"${path}" is not an absolute path.` }
  }
  if (!Object.prototype.hasOwnProperty.call(state?.profiles ?? {}, profileName)) {
    const names = Object.keys(state?.profiles ?? {})
    return {
      ok: false,
      reason:
        `"${profileName}" is not a profile.` +
        (names.length > 0 ? ` Known profiles: ${names.join(', ')}.` : ''),
    }
  }
  const previous = toEntry(state?.bindings?.[key], key)
  return {
    ok: true,
    key,
    replaced: previous?.name ?? null,
    state: { ...state, bindings: { ...(state?.bindings ?? {}), [key]: profileName } },
  }
}

/**
 * Remove the binding for exactly this path — never an ancestor's. Unbinding a
 * directory you are merely inside of would delete a binding you did not name.
 */
export function unbindPath(
  state: State,
  path: string,
): { state: State; key: string | null; removed: string | null } {
  const key = normalizeBindingKey(path)
  if (key === null) return { state, key: null, removed: null }
  const bindings = { ...(state?.bindings ?? {}) }
  const previous = toEntry(bindings[key], key)
  if (!Object.prototype.hasOwnProperty.call(bindings, key)) {
    return { state, key, removed: null }
  }
  delete bindings[key]
  return { state: { ...state, bindings }, key, removed: previous?.name ?? '(unreadable)' }
}

/** Drop every binding that names this profile. Used when a profile is deleted. */
export function pruneBindingsForProfile(
  state: State,
  profileName: string,
): { state: State; removed: string[] } {
  const bindings: Record<string, BindingValue> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(state?.bindings ?? {})) {
    const entry = toEntry(value, key)
    if (entry?.name === profileName) removed.push(key)
    else bindings[key] = value
  }
  return { state: { ...state, bindings }, removed }
}

/**
 * Drop bindings whose directory is gone or whose profile is gone.
 *
 * `pathExists` is injected because this is the ONLY code path allowed to touch
 * the filesystem for bindings. Resolution never stats anything, so a dead path
 * is inert until someone explicitly asks for a prune.
 */
export function pruneBindings(
  state: State,
  pathExists: (key: string) => boolean,
): { state: State; removed: PrunedBinding[] } {
  const bindings: Record<string, BindingValue> = {}
  const removed: PrunedBinding[] = []
  for (const entry of bindingEntries(state)) {
    const gone = !pathExists(entry.key)
    if (gone || entry.dangling) {
      removed.push({ ...entry, reason: gone ? 'directory no longer exists' : 'profile no longer exists' })
      continue
    }
    // `entry.key` came out of `Object.entries(state.bindings)` a few lines up,
    // so the lookup cannot miss — but `noUncheckedIndexedAccess` cannot know
    // that, and the honest way to say it is a check rather than a `!`. The
    // branch is unreachable in practice; if it ever were taken, skipping the
    // key is also the right answer, since a binding with no value is exactly
    // what this function exists to drop.
    const value = state.bindings[entry.key]
    if (value !== undefined) bindings[entry.key] = value
  }
  return { state: { ...state, bindings }, removed }
}

/**
 * What would apply in this directory, and why.
 *
 * Returns the winning binding, the paths that were searched to find it, and
 * what the launch falls back to when nothing matched — the three things needed
 * to explain a profile someone did not expect.
 */
export function explainBinding(
  cwd: string | null | undefined,
  state: State,
  platform: string = 'linux',
): {
  cwd: string | null
  searched: string[]
  match: { key: string; name: string; overrides: ProfileOverrides | null } | null
  dangling: boolean
  defaultProfile: string | null
  exact: boolean
} {
  const searched = ancestorsOf(cwd, state?.bindings, state?.settings)
  const match = resolveBinding(cwd, state?.bindings, state?.settings, platform)
  const profiles = state?.profiles ?? {}
  // `match !== null` rather than `Boolean(match)`: identical at runtime, since
  // `match` is an object or null and every object is truthy — but only the
  // former narrows `match` for the property access that follows.
  const dangling = match !== null && !Object.prototype.hasOwnProperty.call(profiles, match.name)

  return {
    cwd: normalizeBindingKey(cwd),
    searched,
    match: match ? { key: match.key, name: match.name, overrides: match.overrides ?? null } : null,
    dangling,
    // What resolution would fall back to if the binding does not apply.
    defaultProfile: state?.defaultProfile ?? null,
    exact: match !== null && searched.includes(match.key),
  }
}
