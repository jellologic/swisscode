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

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The tool the probe forces the model to call. Trivial on purpose: a schema
 * with anything unusual in it would test the gateway's schema handling rather
 * than whether tool calling works at all.
 */
export const PROBE_TOOL = Object.freeze({
  name: 'cuckoocode_ping',
  description: 'Reply by calling this tool with ok=true.',
  input_schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
})

export function messagesUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`
}

/**
 * Mirrors how Claude Code presents each credential, so a doctor pass that
 * succeeds means the launch will too: x-api-key for ANTHROPIC_API_KEY,
 * Authorization: Bearer for ANTHROPIC_AUTH_TOKEN.
 */
export function authHeaders(credentialEnv, credential) {
  if (!credential) return {}
  return credentialEnv === 'ANTHROPIC_API_KEY'
    ? { 'x-api-key': credential }
    : { authorization: `Bearer ${credential}` }
}

export function probeBody(model, { tools = false } = {}) {
  const body = {
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

/** Pull a human-readable error out of whatever shape the gateway returned. */
export function errorMessage(payload) {
  if (typeof payload === 'string') return payload.slice(0, 300)
  if (!payload || typeof payload !== 'object') return null
  const e = payload.error ?? payload
  const msg = e?.message ?? e?.msg ?? e?.detail ?? null
  return typeof msg === 'string' ? msg.slice(0, 300) : null
}

/** Did the model actually emit a tool_use block? */
export function usedTool(payload) {
  const content = payload?.content
  return Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
}

/**
 * @param {{fetchImpl?:Function}} [deps]
 * @returns {{messages: (opts:object) => Promise<object>}}
 */
export function createProbe({ fetchImpl = globalThis.fetch } = {}) {
  async function messages({
    baseUrl,
    credentialEnv,
    credential,
    model,
    tools = false,
    timeoutMs = 8000,
  }) {
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

      let payload = null
      try {
        payload = await res.json()
      } catch {
        // A non-JSON body is still diagnostic: the status code carries the
        // finding, and a gateway that returns HTML is itself worth knowing.
        payload = null
      }

      return {
        status: res.status,
        message: errorMessage(payload),
        usedTool: tools ? usedTool(payload) : false,
        timedOut: false,
        networkError: null,
        timeoutMs,
      }
    } catch (err) {
      const aborted = err?.name === 'AbortError' || controller.signal.aborted
      return {
        status: null,
        message: null,
        usedTool: false,
        timedOut: aborted,
        networkError: aborted ? null : (err?.message ?? String(err)),
        timeoutMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { messages }
}
