// What is true about a provider account, decided once.
//
// WHY THIS EXISTS. Three surfaces ask the same questions about an account — the
// CLI (`config accounts`), the web API, and the browser screen — and before this
// module each answered them itself. That is not a tidiness complaint; the copies
// had already diverged into a wrong answer:
//
//   web API      refused to save an account holding a key AND a session dir
//   onboard      refused to create one
//   the launch   silently dropped the key and set the session dir, no warning
//   the doctor   reported "no ANTHROPIC_API_KEY; this provider allows that"
//                for a config that visibly contains an API key
//
// Four behaviours, one rule, no owner. The rule lives here now, and the launch
// path and doctor consult the same function the web enforces.
//
// EVERY FUNCTION TAKES THE NARROWEST STRUCTURAL SHAPE IT NEEDS rather than
// `State` or `ProviderAccount`. That is deliberate: the browser bundle is a
// separate TypeScript project with its own mirrored types, and parameters typed
// this way are satisfiable from both sides without either importing the other's
// vocabulary. It also states honestly how little each answer depends on.

/**
 * The credential-bearing fields, whatever object they arrived on.
 *
 * `hasKey` is here because REDACTION IS A FIRST-CLASS SHAPE IN THIS CODEBASE,
 * not an afterthought: the web API never sends `apiKey` to the browser, it sends
 * `hasKey: boolean`. Without this the browser could not ask the shared
 * classifier its question and would need a fourth private copy of the rule —
 * which is the exact failure this module was written to end.
 */
export type CredentialFields = {
  apiKey?: string | undefined
  apiKeyFromEnv?: string | undefined
  configDir?: string | undefined
  /** the redacted stand-in for `apiKey`; equivalent for classification */
  hasKey?: boolean | undefined
}

/**
 * How an account authenticates.
 *
 * `conflict` is a REAL STATE, not an error case to be normalised away. A config
 * can be hand-edited, and a build that only modelled the three valid answers
 * would have to pick one for the fourth — which is exactly the silent
 * wrong-account behaviour this whole area exists to end.
 */
export type CredentialSource = 'key' | 'key-from-env' | 'session' | 'none' | 'conflict'

export function credentialSource(account: CredentialFields): CredentialSource {
  const hasKey = Boolean(account.apiKey || account.apiKeyFromEnv || account.hasKey)
  const hasSession = Boolean(account.configDir)
  if (hasKey && hasSession) return 'conflict'
  if (hasSession) return 'session'
  if (account.apiKeyFromEnv) return 'key-from-env'
  if (account.apiKey || account.hasKey) return 'key'
  return 'none'
}

/**
 * The one sentence every surface uses for the conflict.
 *
 * Exported as a constant rather than written out at each call site because the
 * three copies of this rule previously carried three different wordings, and a
 * user who hits it in the web UI and then in the CLI should not have to work out
 * whether they are the same problem.
 */
export const CONFLICT_REASON =
  'an account authenticates with either an API key or an existing agent login (a session ' +
  'directory), never both — which one pays must never have a subtle answer'

/**
 * Whether an account is well-formed. `null` means fine.
 *
 * Deliberately NOT a throw and not a boolean: callers need the sentence, and
 * they present it very differently — a 400 body, a stderr line, a doctor check.
 */
export function validateAccount(
  account: CredentialFields & { provider?: string | undefined },
): string | null {
  if (!account.provider) return 'provider is required'
  if (credentialSource(account) === 'conflict') return CONFLICT_REASON
  return null
}

/**
 * Which profiles name this account — the reverse index.
 *
 * A profile lists its accounts; nothing else says which profiles an account
 * backs, and that is the question you have before deleting one or rotating a
 * key. Sorted, because two surfaces listing the same set in different orders
 * reads as a difference in meaning.
 */
export function accountsUsedBy(
  profiles: Record<string, { accounts?: string[] | undefined }> | null | undefined,
  accountName: string,
): string[] {
  return Object.entries(profiles ?? {})
    .filter(([, p]) => (p.accounts ?? []).includes(accountName))
    .map(([name]) => name)
    .sort()
}
