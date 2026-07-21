// Directory -> profile bindings.
//
// The bindings map arrives inside the config JSON that is already being read,
// so the "walk" is string arithmetic on path components. No stat, no readdir,
// no realpath, no dotfile probing — ever, on the launch path. A user who never
// binds anything pays one property check.
//
// Zero imports on purpose: this is the launch path, and dirname on an already
// normalized absolute path is a lastIndexOf.

export const DEFAULT_WALK_DEPTH = 40

const WIN_DRIVE = /^[A-Za-z]:$/

export function isAbsolutePath(p) {
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
export function normalizeBindingKey(p) {
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

  const parts = []
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
export function parentOf(key) {
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

function depthOf(key) {
  let d = 0
  let cur = key
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
export function minBindingDepth(bindings) {
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
 *
 * @returns {{name:string, key:string, overrides?:object}|null}
 */
export function resolveBinding(cwd, bindings, settings = {}, platform = 'linux') {
  if (!bindings || typeof bindings !== 'object') return null
  const keys = Object.keys(bindings)
  if (keys.length === 0) return null // fast path: one property check

  const start = normalizeBindingKey(cwd)
  if (start === null) return null

  const floor = minBindingDepth(bindings) ?? 0
  const cap = Number.isInteger(settings?.bindingWalkDepth)
    ? settings.bindingWalkDepth
    : DEFAULT_WALK_DEPTH
  const budget = Math.max(0, Math.min(depthOf(start) - floor, cap))

  const exact = walk(start, budget, (k) =>
    Object.prototype.hasOwnProperty.call(bindings, k) ? k : null,
  )
  if (exact) return toEntry(bindings[exact], exact)

  if (platform !== 'darwin' && platform !== 'win32') return null

  const folded = new Map()
  for (const k of keys) {
    const lower = k.toLowerCase()
    if (!folded.has(lower)) folded.set(lower, k)
  }
  const hit = walk(start, budget, (k) => folded.get(k.toLowerCase()) ?? null)
  return hit ? toEntry(bindings[hit], hit) : null
}

function walk(start, budget, probe) {
  let cur = start
  for (let i = 0; i <= budget && cur !== null; i++) {
    const hit = probe(cur)
    if (hit !== null) return hit
    const next = parentOf(cur)
    if (next === cur) break // belt and braces: POSIX root, C:\, UNC root
    cur = next
  }
  return null
}

function toEntry(value, key) {
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
export function ancestorsOf(cwd, bindings, settings = {}) {
  // Mirrors resolveBinding's fast path: with no bindings stored, nothing is
  // searched at all, so reporting a walk to the filesystem root would describe
  // work that never happens.
  if (!bindings || Object.keys(bindings).length === 0) return []
  const start = normalizeBindingKey(cwd)
  if (start === null) return []
  const floor = minBindingDepth(bindings) ?? 0
  const cap = Number.isInteger(settings?.bindingWalkDepth)
    ? settings.bindingWalkDepth
    : DEFAULT_WALK_DEPTH
  const budget = Math.max(0, Math.min(depthOf(start) - floor, cap))

  const out = []
  let cur = start
  for (let i = 0; i <= budget && cur !== null; i++) {
    out.push(cur)
    const next = parentOf(cur)
    if (next === cur) break
    cur = next
  }
  return out
}

/** Every stored binding, flattened and flagged. Sorted for stable output. */
export function bindingEntries(state) {
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

/**
 * Bind a directory to a profile.
 * @returns {{ok:true, state:object, key:string, replaced:string|null}|{ok:false, reason:string}}
 */
export function bindPath(state, path, profileName) {
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
 * @returns {{state:object, key:string|null, removed:string|null}}
 */
export function unbindPath(state, path) {
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
export function pruneBindingsForProfile(state, profileName) {
  const bindings = {}
  const removed = []
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
 *
 * @param {(key:string) => boolean} pathExists
 */
export function pruneBindings(state, pathExists) {
  const bindings = {}
  const removed = []
  for (const entry of bindingEntries(state)) {
    const gone = !pathExists(entry.key)
    if (gone || entry.dangling) {
      removed.push({ ...entry, reason: gone ? 'directory no longer exists' : 'profile no longer exists' })
      continue
    }
    bindings[entry.key] = state.bindings[entry.key]
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
export function explainBinding(cwd, state, platform = 'linux') {
  const searched = ancestorsOf(cwd, state?.bindings, state?.settings)
  const match = resolveBinding(cwd, state?.bindings, state?.settings, platform)
  const profiles = state?.profiles ?? {}
  const dangling = Boolean(match) && !Object.prototype.hasOwnProperty.call(profiles, match.name)

  return {
    cwd: normalizeBindingKey(cwd),
    searched,
    match: match ? { key: match.key, name: match.name, overrides: match.overrides ?? null } : null,
    dangling,
    // What resolution would fall back to if the binding does not apply.
    defaultProfile: state?.defaultProfile ?? null,
    exact: Boolean(match) && searched.includes(match.key),
  }
}

