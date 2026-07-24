// Extract every environment variable a Claude Code build references.
//
// WHY A SCRIPT AND NOT A PASTED SNAPSHOT. The catalog it produces is committed
// (the build must not require Claude Code to be installed), so without this it
// would be a list nobody could regenerate, aging silently against a binary that
// ships weekly. Re-run it against a newer Claude Code and diff.
//
//   node scripts/extract-claude-env.mjs > src/adapters/agents/claude-code/env-catalog.ts
//
// WHAT THIS CANNOT DO, stated up front because the output is a UI surface:
// it reads STRINGS OUT OF A BINARY. That yields names, and nothing else. It
// cannot yield meaning, defaults, accepted values, or whether a variable is
// still wired to anything. Every description in the output comes from the
// hand-maintained table below — never from the binary — and anything absent
// from that table ships explicitly marked as undocumented rather than given a
// plausible-sounding guess. A wrong description is worse than no description:
// it is a claim someone will act on.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the native installer puts versioned binaries. */
function findBinary() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  const dir = join(homedir(), '.local', 'share', 'claude', 'versions')
  if (!existsSync(dir)) return null
  const versions = readdirSync(dir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i]
      return 0
    })
  for (const v of versions) {
    const candidate = join(dir, v)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const binary = findBinary()
if (!binary) {
  console.error(
    'extract-claude-env: no Claude Code binary found. Pass one explicitly:\n' +
      '  node scripts/extract-claude-env.mjs /path/to/claude',
  )
  process.exit(2)
}

const version = binary.split('/').pop()

const raw = execFileSync('strings', ['-a', binary], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 1024,
})

// Anthropic's two prefixes. `CLAUDE_` alone is deliberately excluded: it also
// matches CLAUDE_CONFIG_DIR-style host variables and a long tail of one-off
// internal names, and widening the net does not make the result more useful.
const names = [...new Set(raw.match(/\b(?:CLAUDE_CODE|ANTHROPIC)_[A-Z0-9_]+\b/g) ?? [])].sort()

/**
 * Names that clearly are not a user-facing knob, by SHAPE rather than by
 * judgement about any individual one.
 *
 * Each rule is something you can check yourself against the list, which matters
 * because this classification is the only thing standing between a browsable
 * catalog and 428 undifferentiated strings.
 */
const INTERNAL = [
  { re: /_FOR_TESTING$|^CLAUDE_CODE_TEST_|_FIXTURE$/, why: 'test hook' },
  { re: /^CLAUDE_CODE_(MOCK|SIMULATE|FORCE_TIP_ID|OVERRIDE_DATE)/, why: 'test hook' },
  { re: /^CLAUDE_CODE_(BENCH|PERFETTO|FRAME_TIMING|PROFILE_(QUERY|STARTUP)|DEBUG_REPAINTS)/, why: 'profiling' },
  { re: /^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS|GOOGLE_CLOUD)/, why: 'third-party cloud provider' },
  { re: /^CLAUDE_CODE_(USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|USE_MANTLE|USE_ANTHROPIC_AWS|USE_ANTHROPIC_GOOGLE_CLOUD|SKIP_.*_AUTH|SKIP_AWS_CRED_CACHE)/, why: 'third-party cloud provider' },
]

/**
 * Two unrelated words joined by an underscore, with nothing else in the name.
 *
 * Anthropic ships unreleased features behind codenames — ALDER_WICKET,
 * BISON_CAIRN, PEWTER_OWL, THISTLE_GREBE. They are indistinguishable from real
 * knobs by name alone, they appear and vanish between releases, and a user who
 * sets one is configuring something nobody can describe. Matched structurally
 * so the rule keeps working on names that do not exist yet.
 */
const CODENAME = /^CLAUDE_CODE_[A-Z]+_[A-Z]+$/

// Words that make a two-word name a real knob rather than a codename. Without
// this, TMUX_PREFIX and MAX_RETRIES would be classified as codenames.
const REAL_WORDS =
  /(MAX|MIN|DISABLE|ENABLE|SKIP|FORCE|USE|API|OAUTH|TOKEN|MODEL|PROXY|TIMEOUT|SESSION|DEBUG|LOG|DIR|PATH|FILE|URL|KEY|MODE|TMUX|SHELL|PLUGIN|SYNC|IDE|OTEL|MCP|OUTPUT|CONTEXT|TOOL|AGENT|MEMORY|REMOTE|SANDBOX|TELEMETRY|VERSION|PROMPT|RETRY|RETRIES|CACHE|GLOB|EFFORT|SUBAGENT|TERMINAL|ARTIFACT|WORKFLOW|ENTRYPOINT|EMAIL|UUID|ID)/

/**
 * The hand-written half. NOTHING HERE COMES FROM THE BINARY.
 *
 * Every entry is a variable whose behaviour is documented by Anthropic, visible
 * in `claude --help`, or already relied on by swisscode's own adapter — which
 * is to say, one somebody can be held to. Everything not in this table ships as
 * `undocumented`, name only.
 */
const DESCRIBED = {
  ANTHROPIC_API_KEY: ['credential', 'The API key Claude Code authenticates with. swisscode sets this per profile; it is cleared for any launch not going to first-party Anthropic.'],
  ANTHROPIC_AUTH_TOKEN: ['credential', 'Bearer-token form of the credential, used by most gateways. swisscode picks this or ANTHROPIC_API_KEY based on the provider descriptor.'],
  ANTHROPIC_BASE_URL: ['endpoint', 'The Anthropic-compatible endpoint to talk to. swisscode sets this from the profile’s provider; a bare host, with no /v1.'],
  ANTHROPIC_MODEL: ['model', 'Overrides the model for the session. Prefer the per-tier ANTHROPIC_DEFAULT_*_MODEL variables, which is what swisscode pins.'],
  ANTHROPIC_SMALL_FAST_MODEL: ['model', 'The model used for cheap background work. Superseded by ANTHROPIC_DEFAULT_HAIKU_MODEL on current builds.'],
  ANTHROPIC_DEFAULT_OPUS_MODEL: ['model', 'Model id for the opus tier. Accepts a [1m] suffix to request the extended context window.'],
  ANTHROPIC_DEFAULT_SONNET_MODEL: ['model', 'Model id for the sonnet tier.'],
  ANTHROPIC_DEFAULT_HAIKU_MODEL: ['model', 'Model id for the haiku tier, used for background and summarisation work.'],
  ANTHROPIC_DEFAULT_FABLE_MODEL: ['model', 'Model id for the fable tier.'],
  ANTHROPIC_CUSTOM_HEADERS: ['endpoint', 'Extra HTTP headers on every API request, as newline-separated Name: Value pairs.'],
  ANTHROPIC_BETAS: ['endpoint', 'Beta headers to include in API requests. API-key users only.'],
  ANTHROPIC_LOG: ['debug', 'Log verbosity for the API client.'],
  CLAUDE_CONFIG_DIR: ['session', 'Which directory holds the login and settings. THE BRANCH IS ON WHETHER THIS IS SET, not on its value — setting it to the default ~/.claude is a different, empty login.'],
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: ['limits', 'Ceiling on tokens the model may produce in one response.'],
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: ['limits', 'Ceiling on the context window Claude Code will fill before compacting.'],
  CLAUDE_CODE_MAX_RETRIES: ['limits', 'How many times a failed API request is retried.'],
  CLAUDE_CODE_MAX_TURNS: ['limits', 'Maximum agent turns before the session stops on its own.'],
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: ['limits', 'How many subagents may run at once.'],
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: ['limits', 'How many tool calls may run in parallel within one turn.'],
  CLAUDE_CODE_SUBAGENT_MODEL: ['model', 'Model subagents run on. Pinning it matters on gateways: subagents 404 when the id is not one the endpoint serves. swisscode sets this for OpenRouter.'],
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: ['limits', 'Fraction of the context window at which auto-compaction triggers.'],
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ['traffic', 'Stops background requests an endpoint may not serve. ALSO disables gateway model discovery, so every tier must be pinned explicitly.'],
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: ['compat', 'Works around gateways that reject the adaptive thinking input tag with 400.'],
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: ['compat', 'Works around gateways that reject unknown beta fields with "Extra inputs are not permitted".'],
  CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: ['compat', 'Skips the organisation check that reports fast mode as disabled on non-first-party endpoints.'],
  CLAUDE_CODE_ATTRIBUTION_HEADER: ['traffic', 'Set to 0 to drop the attribution header, which improves prompt-cache hit rate through some gateways.'],
  CLAUDE_CODE_DISABLE_1M_CONTEXT: ['limits', 'Turns off the 1M context window request.'],
  CLAUDE_CODE_DISABLE_THINKING: ['behaviour', 'Disables extended thinking.'],
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: ['ui', 'Stops Claude Code rewriting the terminal window title.'],
  CLAUDE_CODE_DISABLE_MOUSE: ['ui', 'Disables mouse reporting, which some terminals and multiplexers handle badly.'],
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: ['behaviour', 'Stops automatic memory capture.'],
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: ['behaviour', 'Stops CLAUDE.md files being discovered and loaded.'],
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: ['behaviour', 'Disables background task execution.'],
  CLAUDE_CODE_ENABLE_TELEMETRY: ['telemetry', 'Enables OpenTelemetry export.'],
  CLAUDE_CODE_SAFE_MODE: ['behaviour', 'Set by --safe-mode. Disables customisations — CLAUDE.md, skills, plugins, hooks, MCP servers — for troubleshooting a broken configuration.'],
  CLAUDE_CODE_SIMPLE: ['behaviour', 'Set by --bare. Skips hooks, LSP, plugin sync, auto-memory, keychain reads and CLAUDE.md discovery.'],
  CLAUDE_CODE_EFFORT_LEVEL: ['behaviour', 'Effort level for the session: low, medium, high, xhigh, max. Also settable with --effort.'],
  CLAUDE_CODE_SHELL: ['environment', 'Which shell the Bash tool uses.'],
  CLAUDE_CODE_TMPDIR: ['environment', 'Temporary directory Claude Code writes to.'],
  CLAUDE_CODE_GIT_BASH_PATH: ['environment', 'Path to Git Bash on Windows.'],
  CLAUDE_CODE_HTTP_PROXY: ['network', 'HTTP proxy for Claude Code’s own requests.'],
  CLAUDE_CODE_HTTPS_PROXY: ['network', 'HTTPS proxy for Claude Code’s own requests.'],
  CLAUDE_CODE_CLIENT_CERT: ['network', 'Client certificate for mTLS.'],
  CLAUDE_CODE_CLIENT_KEY: ['network', 'Client key for mTLS.'],
  CLAUDE_CODE_ENTRYPOINT: ['environment', 'How Claude Code was started. swisscode does not set this; the agent uses it for its own telemetry.'],
  CLAUDE_CODE_VERSION: ['environment', 'The running Claude Code version.'],
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: ['traffic', 'Lets Claude Code ask a gateway which models it serves. Disabled as a side effect of CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.'],
  CLAUDE_CODE_API_KEY_HELPER_TTL_MS: ['credential', 'How long a credential from apiKeyHelper is cached.'],
  CLAUDE_CODE_OAUTH_TOKEN: ['credential', 'OAuth access token. Written by /login; swisscode reads it only to measure subscription usage, and never refreshes it.'],
  CLAUDE_CODE_SUBSCRIPTION_TYPE: ['credential', 'The plan behind the current login, e.g. max.'],
  CLAUDE_CODE_DEBUG_LOG_LEVEL: ['debug', 'Verbosity of debug logging. Also settable with --debug.'],
  CLAUDE_CODE_DEBUG_LOGS_DIR: ['debug', 'Where debug logs are written.'],
  CLAUDE_CODE_SESSION_ID: ['session', 'The current session id. Also settable with --session-id.'],
  CLAUDE_CODE_MANAGED_SETTINGS_PATH: ['environment', 'Path to admin-managed policy settings.'],
  ENABLE_TOOL_SEARCH: ['compat', 'Enables MCP tool search, which is off by default away from first-party Anthropic.'],
  API_FORCE_IDLE_TIMEOUT: ['compat', 'Set to 0 to stop the client giving up on slow or locally hosted models.'],
  MAX_THINKING_TOKENS: ['limits', 'Ceiling on tokens spent on extended thinking.'],
  DISABLE_TELEMETRY: ['telemetry', 'Disables telemetry reporting.'],
  DISABLE_ERROR_REPORTING: ['telemetry', 'Disables error reporting.'],
  DISABLE_AUTOUPDATER: ['behaviour', 'Stops Claude Code updating itself.'],
}

// Variables swisscode itself writes, so the UI can say "this one is already
// yours to set from a profile" instead of listing it as inert trivia.
const SWISSCODE_SETS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', 'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'ENABLE_TOOL_SEARCH', 'API_FORCE_IDLE_TIMEOUT',
])

function classify(name) {
  // THE HAND-WRITTEN TABLE OUTRANKS EVERY HEURISTIC, and the order here is the
  // whole point rather than a detail. A description in DESCRIBED means somebody
  // verified the variable; a regex is a guess about a name's shape. Running the
  // guesses first got `CLAUDE_CODE_ATTRIBUTION_HEADER` — a variable swisscode
  // sets itself — filed as an "unreleased feature codename", because it happens
  // to be two words. Caught by the catalog's own tests, not by reading.
  if (DESCRIBED[name]) return { kind: 'documented' }
  for (const rule of INTERNAL) if (rule.re.test(name)) return { kind: 'internal', why: rule.why }
  if (CODENAME.test(name) && !REAL_WORDS.test(name)) {
    return { kind: 'internal', why: 'unreleased feature codename' }
  }
  return { kind: 'undocumented' }
}

// Names swisscode knows about that the binary does not spell with a prefix we
// scan for (ENABLE_TOOL_SEARCH, MAX_THINKING_TOKENS, …). Included so the
// catalog is not narrower than the adapter it describes.
const extra = Object.keys(DESCRIBED).filter((n) => !names.includes(n))
const all = [...names, ...extra].sort()

const entries = all.map((name) => {
  const c = classify(name)
  const described = DESCRIBED[name]
  return {
    name,
    kind: c.kind,
    ...(c.why ? { why: c.why } : {}),
    ...(described ? { category: described[0], description: described[1] } : {}),
    ...(SWISSCODE_SETS.has(name) ? { managed: true } : {}),
  }
})

const counts = entries.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {})

process.stdout.write(`// GENERATED by scripts/extract-claude-env.mjs — do not edit by hand.
//
// Every environment variable referenced by Claude Code ${version}, extracted
// from the shipped binary, plus the ones swisscode's own adapter sets.
//
// READ THE 'kind' FIELD BEFORE TRUSTING AN ENTRY. Extraction yields NAMES AND
// NOTHING ELSE — no meaning, no defaults, no accepted values, and no evidence
// that a name is still wired to anything. So:
//
//   documented    ${String(counts.documented ?? 0).padStart(3)}  described by hand from Anthropic's docs, \`claude --help\`,
//                      or swisscode's own adapter. Safe to act on.
//   undocumented  ${String(counts.undocumented ?? 0).padStart(3)}  the name is real; the meaning is NOT KNOWN. Shipped
//                      without a description on purpose — a plausible guess is
//                      worse than a blank, because someone will act on it.
//   internal      ${String(counts.internal ?? 0).padStart(3)}  test hooks, profiling switches, third-party cloud
//                      auth, and unreleased feature codenames. Present for
//                      completeness; not knobs.
//
// Regenerate against a newer Claude Code and diff:
//   node scripts/extract-claude-env.mjs > src/adapters/agents/claude-code/env-catalog.ts

/** How much is actually known about an entry. */
export type ClaudeEnvKind = 'documented' | 'undocumented' | 'internal'

export type ClaudeEnvVar = {
  name: string
  kind: ClaudeEnvKind
  /** why it was classified internal; absent otherwise */
  why?: string
  category?: string
  /** hand-written, never extracted; absent for undocumented and internal */
  description?: string
  /** swisscode's own adapter sets this one from a profile */
  managed?: boolean
}

/** The Claude Code build this was extracted from. */
export const CATALOG_SOURCE = ${JSON.stringify({ agent: 'claude-code', version })} as const

export const CLAUDE_ENV_CATALOG: readonly ClaudeEnvVar[] = Object.freeze(${JSON.stringify(entries, null, 2)})
`)
