// Port: what a provider preset has to tell the launcher.
//
// This file is JSDoc only. Its single runtime statement is `export {}` — ports
// describe shapes, they do not participate at runtime. No classes, no base
// classes, no `implements`. Descriptors are plain data (see adapters/providers).

/** @typedef {'opus'|'sonnet'|'haiku'|'fable'} Tier */

/**
 * A model family that genuinely supports an extended context window.
 * `models` lists BARE ids; the `[1m]` suffix is derived at env-build time by
 * core/context.js and must never be typed into a descriptor.
 *
 * This is a CAPABILITY DECLARATION, not a string transformation. A model earns
 * the suffix by being named here, which is why "apply [1m] only where the model
 * genuinely supports 1M" is enforceable rather than aspirational: adding a
 * model to `models` is a deliberate act a reviewer sees, and
 * test/registry.test.js cross-checks the claim against `defaultModels`.
 *
 * Verified against vendor documentation. Do NOT add a model on the strength of
 * a blog post — an id carrying [1m] that the endpoint does not recognise is a
 * hard failure, and one that silently does not honour it is a 200K window
 * wearing a 1M label.
 *
 * @typedef {Object} ExtendedContext
 * @property {boolean}  supported
 * @property {string[]} models    bare ids that genuinely support the wider window
 * @property {number}   [window]  documented window shared by `models`, e.g. 1000000
 * @property {Record<string,number>} [windows]  per-model override where the
 *   family does not agree on one number (kimi-k3 documents 1048576, not 1e6).
 */

/**
 * Gateway compatibility switches. Each maps to exactly one env var; the mapping
 * lives in core/env.js so a descriptor never spells a variable name and a
 * typo'd name cannot become a silent no-op.
 *
 * A provider ships these as defaults. A profile may override any single key —
 * `"compat": {"disableAdaptiveThinking": true}` in config.json — and a profile
 * setting one to `false` actively unsets the variable rather than leaving one
 * inherited from the shell.
 *
 * Each flag names the symptom it clears, because that is the only thing that
 * makes it possible to decide whether you need one:
 *
 *   disableExperimentalBetas  HTTP 400 "Extra inputs are not permitted"
 *   disableAdaptiveThinking   HTTP 400 "Input tag 'adaptive' found"
 *   skipFastModeOrgCheck      fast mode reports "disabled by organization"
 *   enableToolSearch          MCP tool search is off by default off-first-party
 *   forceIdleTimeoutOff       long stalls on slow or locally hosted models
 *   dropAttributionHeader     poor prompt-cache hit rate through a gateway
 *
 * There is deliberately NO flag for CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
 * It also disables gateway model discovery, so it must not be reachable from a
 * boolean that reads like a harmless compatibility switch.
 *
 * @typedef {Object} CompatFlags
 * @property {boolean} [disableExperimentalBetas]
 * @property {boolean} [disableAdaptiveThinking]
 * @property {boolean} [skipFastModeOrgCheck]
 * @property {boolean} [enableToolSearch]
 * @property {boolean} [forceIdleTimeoutOff]
 * @property {boolean} [dropAttributionHeader]
 */

/**
 * @typedef {Object} ProviderDescriptor
 * @property {string}  id
 * @property {string}  label
 * @property {string|null} baseUrl   null = actively CLEAR ANTHROPIC_BASE_URL
 * @property {boolean} [askBaseUrl]  wizard prompts for the URL
 * @property {'ANTHROPIC_AUTH_TOKEN'|'ANTHROPIC_API_KEY'} credentialEnv
 * @property {boolean} [credentialOptional]
 * @property {Partial<Record<Tier,string>>} defaultModels  BARE ids, never [1m]
 * @property {Record<string,string>} [env]      vars to SET
 * @property {string[]}              [unsetEnv] vars to REMOVE
 * @property {CompatFlags}     [compat]   defaults; a profile may override any key
 * @property {ExtendedContext} [extendedContext]
 * @property {string|null}     [catalogId]  id of a ModelCatalogPort, or null
 * @property {boolean}         [subagentFollowsOpus]
 * @property {{keyHint?:string, modelHint?:string, note?:string}} [hints] UI only
 */

// Descriptors use the explicit env / unsetEnv split and may NEVER use '' to
// mean unset — registry.test.js fails any descriptor that does. The
// ''-means-unset convention is a user-facing contract (profile.env,
// profile.models) and stays exactly as documented in the README.

export {}
