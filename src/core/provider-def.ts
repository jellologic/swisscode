// Validation for USER-DEFINED providers.
//
// This module exists because a guarantee changed hands. Shipped provider
// descriptors are constants in source, and test/registry.test.ts proves things
// about them: base URLs carry no /v1, third-party endpoints clear
// ANTHROPIC_API_KEY, no model id is hand-typed with [1m], every compat flag is
// real. A provider that arrives from config.json is out of reach of every one
// of those tests, and adding a form to type one in does not make the checks
// unnecessary — it makes them RUNTIME checks.
//
// So each rule below is the runtime twin of a test in registry.test.ts, and
// says which failure it prevents. Pure: no I/O, no registry lookups beyond the
// reserved-id list it is handed.

import { TIERS, isTier } from './tiers.ts'
import type { CustomProvider } from '../ports/config-store.ts'

/**
 * `errors` block the save. `warnings` do not — they describe a configuration
 * that is legal and probably wrong, which is a distinction the user is entitled
 * to make for themselves (a plain-http endpoint on a trusted LAN, say).
 */
export type ProviderValidation = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** Same grammar as a profile name: predictable in a URL and in argv. */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

const EXTENDED_MARKER = '[1m]'

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

export type ValidateOptions = {
  /** ids of shipped presets, which a user provider may not shadow */
  reservedIds: readonly string[]
  /** known compat flag names, so a typo is caught rather than silently inert */
  knownCompatFlags: readonly string[]
  /**
   * Which variable spellings may carry the credential.
   *
   * INJECTED, like `knownCompatFlags`, and for the reason the architecture test
   * enforces: those spellings are Claude Code dialect, and core/ may not name an
   * ANTHROPIC_* variable in emitted code. Writing the list inline here compiled
   * fine and failed that test immediately — which is the check working.
   */
  credentialEnvs: readonly string[]
}

export function validateCustomProvider(
  input: unknown,
  { reservedIds, knownCompatFlags, credentialEnvs }: ValidateOptions,
): ProviderValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const push = (c: boolean, msg: string): void => {
    if (c) errors.push(msg)
  }

  if (!isObjectLike(input)) {
    return { ok: false, errors: ['a provider must be an object'], warnings }
  }

  // id
  const id = typeof input.id === 'string' ? input.id : ''
  push(!ID_RE.test(id), 'id must start with a letter or digit and use only a-z, 0-9, . _ -')
  // Shadowing a shipped preset is refused rather than allowed to win or lose by
  // registration order: `openrouter` meaning something different on one machine
  // is precisely the confusion this tool exists to remove.
  push(
    reservedIds.includes(id),
    `"${id}" is a shipped provider; pick another id rather than shadowing it`,
  )

  push(typeof input.label !== 'string' || !input.label.trim(), 'label is required')

  // base URL — the /v1 trap is the single most common way to build a preset
  // that 404s, and it has its own test for the shipped ones.
  const rawUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (!rawUrl) {
    errors.push('baseUrl is required')
  } else {
    let url: URL | null = null
    try {
      url = new URL(rawUrl)
    } catch {
      errors.push(`baseUrl "${rawUrl}" is not a valid URL`)
    }
    if (url) {
      push(
        url.protocol !== 'http:' && url.protocol !== 'https:',
        'baseUrl must be http:// or https://',
      )
      push(
        /\/v1\/?$/.test(url.pathname),
        'baseUrl ends in /v1 — that is the OpenAI-compatible route. Claude Code appends ' +
          '/v1/messages itself, so this would request /v1/v1/messages and 404.',
      )
      if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
        warnings.push(
          `credentials sent to ${url.origin} travel in cleartext to a non-loopback host, ` +
            'where anyone on the network path can read them',
        )
      }
      if (url.username || url.password) {
        warnings.push(
          'baseUrl carries credentials in its userinfo; they are stored in config.json and ' +
            'printed in some diagnostics. Prefer the credential field.',
        )
      }
    }
  }

  // credential
  if (input.credentialEnv !== undefined) {
    push(
      typeof input.credentialEnv !== 'string' ||
        !credentialEnvs.includes(input.credentialEnv as string),
      `credentialEnv must be one of ${credentialEnvs.join(' or ')}`,
    )
  }
  if (input.defaultCredential !== undefined) {
    push(typeof input.defaultCredential !== 'string', 'defaultCredential must be a string')
    // A placeholder ships in the clear by definition; if it were secret it
    // would belong on the profile as a key, not on the provider.
    if (typeof input.defaultCredential === 'string' && input.defaultCredential.length > 24) {
      warnings.push(
        'defaultCredential looks like a real secret. It is stored as provider data and is ' +
          'not redacted anywhere — put real keys on the profile instead.',
      )
    }
  }

  // models
  if (input.defaultModels !== undefined) {
    if (!isObjectLike(input.defaultModels)) {
      errors.push('defaultModels must be an object keyed by tier')
    } else {
      for (const [tier, value] of Object.entries(input.defaultModels)) {
        push(!isTier(tier), `"${tier}" is not a model tier (${TIERS.join(', ')})`)
        push(typeof value !== 'string', `defaultModels.${tier} must be a string`)
        push(
          typeof value === 'string' && value.endsWith(EXTENDED_MARKER),
          `defaultModels.${tier} carries ${EXTENDED_MARKER}. That suffix is derived from a ` +
            'verified capability, never typed in — a model id the endpoint does not recognise ' +
            'fails hard.',
        )
      }
    }
  }

  // env / unsetEnv — descriptors use the explicit split, and '' as a sentinel is
  // banned there precisely so "set to empty" and "remove" stay distinguishable.
  if (input.env !== undefined) {
    if (!isObjectLike(input.env)) {
      errors.push('env must be an object of string values')
    } else {
      for (const [k, v] of Object.entries(input.env)) {
        push(typeof v !== 'string', `env.${k} must be a string`)
        push(
          v === '',
          `env.${k} is an empty string. Use unsetEnv to remove a variable; '' as a sentinel is ` +
            'a profile-level convention that does not apply to a provider.',
        )
      }
    }
  }
  if (input.unsetEnv !== undefined) {
    push(
      !Array.isArray(input.unsetEnv) || input.unsetEnv.some((v) => typeof v !== 'string'),
      'unsetEnv must be an array of variable names',
    )
  }

  // compat — a misspelled flag is a silent no-op, which is the failure the
  // named-boolean design exists to prevent.
  if (input.compat !== undefined) {
    if (!isObjectLike(input.compat)) {
      errors.push('compat must be an object of booleans')
    } else {
      for (const [flag, value] of Object.entries(input.compat)) {
        push(
          !knownCompatFlags.includes(flag),
          `"${flag}" is not a compat flag. Known flags: ${knownCompatFlags.join(', ')}.`,
        )
        push(typeof value !== 'boolean', `compat.${flag} must be a boolean`)
      }
    }
  }

  if (input.subagentFollowsOpus !== undefined) {
    push(typeof input.subagentFollowsOpus !== 'boolean', 'subagentFollowsOpus must be a boolean')
  }

  // Refused outright rather than ignored: silently dropping a field the user
  // typed would leave them believing a capability is active.
  push(
    'extendedContext' in input,
    'extendedContext cannot be declared on a custom provider. The [1m] suffix asserts a ' +
      'verified capability; set the profile’s contextWindows instead, which drives ' +
      'auto-compaction without claiming a wider window.',
  )
  push(
    'catalogId' in input,
    'catalogId cannot be set on a custom provider — a catalog needs a shipped adapter that ' +
      'understands the upstream response shape.',
  )

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Narrow a validated object to `CustomProvider`, dropping anything unknown.
 *
 * Whitelisted rather than spread: an unrecognised key written into config.json
 * could be read as meaningful by a future swisscode, so what a user typed and
 * what gets stored must be the same known set.
 */
export function toCustomProvider(input: Record<string, unknown>): CustomProvider {
  const out: CustomProvider = {
    id: String(input.id),
    label: String(input.label),
    baseUrl: String(input.baseUrl).trim(),
  }
  if (typeof input.credentialEnv === 'string') {
    out.credentialEnv = input.credentialEnv as NonNullable<CustomProvider['credentialEnv']>
  }
  if (typeof input.credentialOptional === 'boolean') out.credentialOptional = input.credentialOptional
  if (typeof input.defaultCredential === 'string') out.defaultCredential = input.defaultCredential
  if (typeof input.subagentFollowsOpus === 'boolean') {
    out.subagentFollowsOpus = input.subagentFollowsOpus
  }
  if (isObjectLike(input.defaultModels)) {
    const models: Partial<Record<string, string>> = {}
    for (const [tier, v] of Object.entries(input.defaultModels)) {
      if (isTier(tier) && typeof v === 'string') models[tier] = v
    }
    out.defaultModels = models as NonNullable<CustomProvider['defaultModels']>
  }
  if (isObjectLike(input.env)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.env)) if (typeof v === 'string') env[k] = v
    out.env = env
  }
  if (Array.isArray(input.unsetEnv)) {
    out.unsetEnv = input.unsetEnv.filter((v): v is string => typeof v === 'string')
  }
  if (isObjectLike(input.compat)) {
    const compat: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(input.compat)) if (typeof v === 'boolean') compat[k] = v
    out.compat = compat as NonNullable<CustomProvider['compat']>
  }
  return out
}
