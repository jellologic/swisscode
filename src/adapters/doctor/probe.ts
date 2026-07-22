// Live endpoint probe for `config doctor`.
//
// NON-STREAMING, ALWAYS, FOR EVERY PROVIDER. This is not a stylistic choice:
// Claude Code always streams, and at least one endpoint we ship a preset for
// (ModelScope) answers a bad token with HTTP 200 followed by an SSE stream that
// dies silently. A streaming probe there cannot tell a rejected credential from
// a slow model — it looks like a hang either way. With `stream: false` the same
// bad token has to produce a status code we can actually read.
//
// Cost: each probe is a real inference request. They are kept to max_tokens 1
// (16 for the tool probe, which has to be able to emit a tool_use block) and
// there is at most one per distinct model plus one tool probe. `--offline`
// skips all of them.
//
// Only reachable through composition/doctor-root.js, which is dynamically
// imported. Nothing here is in the launch path's static closure.

import type {
  AnthropicMessagesProbePort,
  ProbeRequest,
  ProbeResult,
} from '../../ports/doctor.ts'
import type { ClaudeCodeCredentialEnv } from '../../ports/claude-code.ts'

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Narrows `unknown` to something indexable, and nothing more — exactly the
 * `!payload || typeof payload !== 'object'` test the checks below already made
 * inline, INCLUDING letting arrays through, which the original also did.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/**
 * The tool the probe forces the model to call. Trivial on purpose: a schema
 * with anything unusual in it would test the gateway's schema handling rather
 * than whether tool calling works at all.
 */
export const PROBE_TOOL = Object.freeze({
  name: 'swisscode_ping',
  description: 'Reply by calling this tool with ok=true.',
  input_schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
})

/**
 * The request body, as SENT. `stream` is the literal `false`, not `boolean`:
 * the one property this probe's whole diagnostic value rests on cannot be
 * flipped to `true` by an edit without failing to compile.
 */
export type ProbeBody = {
  model: string
  max_tokens: number
  stream: false
  messages: Array<{ role: 'user'; content: string }>
  tools?: Array<typeof PROBE_TOOL>
  tool_choice?: { type: 'tool'; name: string }
}

export function messagesUrl(baseUrl: string): string {
  return `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`
}

/**
 * Mirrors how Claude Code presents each credential, so a doctor pass that
 * succeeds means the launch will too: x-api-key for ANTHROPIC_API_KEY,
 * Authorization: Bearer for ANTHROPIC_AUTH_TOKEN.
 */
export function authHeaders(
  credentialEnv: ClaudeCodeCredentialEnv,
  credential: string | null,
): Record<string, string> {
  if (!credential) return {}
  return credentialEnv === 'ANTHROPIC_API_KEY'
    ? { 'x-api-key': credential }
    : { authorization: `Bearer ${credential}` }
}

export function probeBody(model: string, { tools = false }: { tools?: boolean } = {}): ProbeBody {
  const body: ProbeBody = {
    model,
    max_tokens: tools ? 16 : 1,
    // Explicit, not omitted. The whole point of this probe is that it is not a
    // stream, and a default that changes under us would silently undo that.
    stream: false,
    messages: [{ role: 'user', content: 'ping' }],
  }
  if (tools) {
    body.tools = [PROBE_TOOL]
    body.tool_choice = { type: 'tool', name: PROBE_TOOL.name }
  }
  return body
}

/** Remove each secret (>= 4 chars) from a string, whole occurrences only. */
function redactSecrets(s: string, secrets: string[]): string {
  let out = s
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('<redacted>')
  }
  return out
}

/**
 * Pull a human-readable error out of whatever shape the gateway returned.
 *
 * `unknown` in, `string | null` out — the parse happens HERE and the RESULT is
 * what gets a type. Nothing downstream is handed a payload that has been
 * asserted into a shape nobody checked.
 *
 * Redaction happens BEFORE the 300-char truncation: a gateway that echoes the
 * full credential in a long body could otherwise have the secret straddle the
 * cut, leaving a prefix fragment that the outer whole-string redactDeep can no
 * longer match. Removing the secret in full first makes that unreachable.
 */
export function errorMessage(payload: unknown, secrets: string[] = []): string | null {
  if (typeof payload === 'string') return redactSecrets(payload, secrets).slice(0, 300)
  if (!isObjectLike(payload)) return null
  const e = payload.error ?? payload
  if (!isObjectLike(e)) return null
  const msg = e.message ?? e.msg ?? e.detail ?? null
  return typeof msg === 'string' ? redactSecrets(msg, secrets).slice(0, 300) : null
}

/** Did the model actually emit a tool_use block? */
export function usedTool(payload: unknown): boolean {
  const content = isObjectLike(payload) ? payload.content : undefined
  if (!Array.isArray(content)) return false
  const blocks: unknown[] = content
  return blocks.some((c) => isObjectLike(c) && c.type === 'tool_use')
}

/**
 * The part of a `fetch` response this probe reads.
 *
 * Spelled structurally, and `json()` returns `unknown` ON PURPOSE. The real
 * `Response.json()` is typed `Promise<any>`, and an `any` here would silently
 * defeat `errorMessage` and `usedTool` — both of which exist precisely to dig
 * through a payload no one has validated. Declaring `unknown` at the injection
 * point CONTAINS that `any`, so the gateway's JSON cannot be read without being
 * narrowed first. The global `fetch` still satisfies this.
 */
export type ProbeResponse = {
  status: number
  json: () => Promise<unknown>
}

/**
 * The HTTP call this probe needs, injected.
 *
 * Minimal and structural for the same reason `SignalHost` is in the process
 * adapter: test/adapters/doctor-probe.test.ts substitutes a stand-in that is
 * not a real `Response`, and naming what is genuinely required is what makes
 * that legitimate rather than an unchecked lie.
 */
export type ProbeFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<ProbeResponse>

export type ProbeDeps = { fetchImpl?: ProbeFetch }

export function createProbe({
  fetchImpl = globalThis.fetch,
}: ProbeDeps = {}): AnthropicMessagesProbePort {
  async function messages({
    baseUrl,
    credentialEnv,
    credential,
    model,
    tools = false,
    timeoutMs = 8000,
  }: ProbeRequest): Promise<ProbeResult> {
    const url = messagesUrl(baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...authHeaders(credentialEnv, credential),
        },
        body: JSON.stringify(probeBody(model, { tools })),
        signal: controller.signal,
      })

      let payload: unknown = null
      try {
        payload = await res.json()
      } catch {
        // A non-JSON body is still diagnostic: the status code carries the
        // finding, and a gateway that returns HTML is itself worth knowing.
        payload = null
      }

      return {
        status: res.status,
        message: errorMessage(payload, credential ? [credential] : []),
        usedTool: tools ? usedTool(payload) : false,
        timedOut: false,
        networkError: null,
        timeoutMs,
      }
    } catch (err) {
      // See the note on `errMessage` in adapters/store/fs-config-store.ts: a
      // caught value is `unknown` under `strict`, and the property read stays
      // the property read so the string the user sees does not change.
      const e = err as { name?: string; message?: string } | null | undefined
      const aborted = e?.name === 'AbortError' || controller.signal.aborted
      return {
        status: null,
        message: null,
        usedTool: false,
        timedOut: aborted,
        networkError: aborted ? null : (e?.message ?? String(err)),
        timeoutMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { messages }
}
