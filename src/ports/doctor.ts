// Port: `cuckoocode config doctor` — the live endpoint probe, and the shapes
// the diagnosis is reported in.
//
// There was no port file for this before; adapters/doctor/probe.js implemented
// a contract that only composition/doctor-root.js knew. It is written down here
// rather than invented — the shapes below are read off that adapter, core/
// doctor.js and doctor-root.js.
//
// Nothing here is on the launch path. Doctor is reached only through a dynamic
// import, because it makes real inference requests and a launcher that quietly
// bills you a token every time you start it would be a worse bug than anything
// it detects.

/**
 * A check's verdict.
 *
 * `skip` is NOT a fourth severity — it means the check did not run (offline, or
 * nothing to check). It contributes to no exit code, which is why it is a
 * distinct state rather than a passing `ok`: reporting "all clear" for work that
 * never happened is the failure mode this avoids.
 */
export type DoctorStatus = 'ok' | 'warn' | 'error' | 'skip'

/**
 * Process exit code. MEANINGFUL, and CI branches on it:
 *
 *   0  clean
 *   1  warnings
 *   2  errors
 *
 * Derived from the checks, never hand-set, so the number and the human-readable
 * report can never disagree.
 */
export type DoctorExitCode = 0 | 1 | 2

/** A repair doctor knows how to apply, but only under an explicit `--fix`. */
export type DoctorRepair = { kind: 'prune' }

export type DoctorCheck = {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  /** advice, shown only for a non-ok status */
  fix?: string
  /** present only where `--fix` can act; doctor proposes, it does not repair */
  repair?: DoctorRepair
}

export type DoctorCounts = Record<DoctorStatus, number>

export type DoctorSummary = {
  counts: DoctorCounts
  exitCode: DoctorExitCode
}

/**
 * The whole report. EVERY string in here has already been through `redact`:
 * the API key is never printed, not even partially — not a prefix, not a
 * suffix, not a length.
 */
export type DoctorReport = {
  profile: string | null
  source: 'positional' | 'flag' | 'binding' | 'default' | null
  provider: string | null
  endpoint: string | null
  checks: DoctorCheck[]
  repairs: string[]
  notes: string[]
  summary: DoctorSummary
}

export type DoctorRun = {
  report: DoctorReport
  exitCode: DoctorExitCode
  render: () => string
}

// ===========================================================================
// AGENT-CLI SEAM (issue #19)
//
// Everything below speaks the ANTHROPIC MESSAGES API specifically: the
// anthropic-version header, x-api-key vs Authorization: Bearer, POST
// /v1/messages, and a tool_use block in the response. That is deliberate — the
// probe exists to verify the exact request Claude Code will make, so a doctor
// pass that succeeds means the launch will too.
//
// It is therefore Claude-Code-shaped by construction and sits on the seam side.
// A different agent CLI brings a different wire protocol and a different probe;
// the neutral half is `DoctorCheck`/`DoctorReport` above, which say nothing
// about HTTP.
// ===========================================================================

import type { ClaudeCodeCredentialEnv } from './provider.ts'

export type ProbeRequest = {
  baseUrl: string
  credentialEnv: ClaudeCodeCredentialEnv
  /** null/'' = probe unauthenticated; some providers allow it */
  credential: string | null
  model: string
  /** force a tool call, to prove tool support rather than mere reachability */
  tools?: boolean
  timeoutMs?: number
}

/**
 * NEVER REJECTS. A transport failure is reported in `networkError` and a
 * timeout in `timedOut`, because both are diagnostic findings rather than
 * exceptional control flow — the whole job of this call is to find out what
 * goes wrong.
 */
export type ProbeResult = {
  /** null when the request never produced a response */
  status: number | null
  /** a human-readable error dug out of whatever shape the gateway returned */
  message: string | null
  /** did the model actually emit a tool_use block? false when not probed */
  usedTool: boolean
  timedOut: boolean
  networkError: string | null
  /** the budget this attempt was given, echoed back for the report */
  timeoutMs: number
}

/**
 * NON-STREAMING, ALWAYS, FOR EVERY PROVIDER. Not a stylistic choice: at least
 * one endpoint cuckoocode ships a preset for answers a bad token with HTTP 200
 * followed by an SSE stream that dies silently. A streaming probe there cannot
 * tell a rejected credential from a slow model — it looks like a hang either
 * way. With `stream: false` the same bad token has to produce a status code.
 */
export type AnthropicMessagesProbePort = {
  messages: (req: ProbeRequest) => Promise<ProbeResult>
}

export {}
