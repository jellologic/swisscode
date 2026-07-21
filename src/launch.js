import { spawn } from 'node:child_process'
import { byId } from './providers.js'
import { resolveClaude } from './resolve.js'

const SKIP_FLAG = '--dangerously-skip-permissions'

export function buildEnv(cfg) {
  const provider = byId(cfg.provider)
  const env = { ...process.env }

  // An empty string means "remove", not "set to empty". Providers rely on this
  // to clear variables that would otherwise conflict.
  const set = (key, value) => {
    if (value === '' || value == null) delete env[key]
    else env[key] = String(value)
  }

  const baseUrl = cfg.baseUrl ?? provider?.baseUrl
  if (baseUrl) set('ANTHROPIC_BASE_URL', baseUrl)

  for (const [key, value] of Object.entries(provider?.env ?? {})) set(key, value)

  if (cfg.apiKey) set(provider?.keyEnv ?? 'ANTHROPIC_AUTH_TOKEN', cfg.apiKey)

  const models = cfg.models ?? {}
  if (models.opus) set('ANTHROPIC_DEFAULT_OPUS_MODEL', models.opus)
  if (models.sonnet) set('ANTHROPIC_DEFAULT_SONNET_MODEL', models.sonnet)
  if (models.haiku) set('ANTHROPIC_DEFAULT_HAIKU_MODEL', models.haiku)
  if (provider?.subagentFollowsOpus && models.opus) {
    set('CLAUDE_CODE_SUBAGENT_MODEL', models.opus)
  }

  // User escape hatch for anything the registry doesn't model.
  for (const [key, value] of Object.entries(cfg.env ?? {})) set(key, value)

  env.CUCKOOCODE = '1'
  return env
}

export function buildArgs(cfg, passthrough, skipOverride) {
  const skip = skipOverride ?? cfg.skipPermissions ?? false
  const alreadyPresent = passthrough.includes(SKIP_FLAG)
  return skip && !alreadyPresent ? [SKIP_FLAG, ...passthrough] : [...passthrough]
}

export function launch(cfg, passthrough, skipOverride) {
  const bin = resolveClaude()
  const env = buildEnv(cfg)
  const args = buildArgs(cfg, passthrough, skipOverride)

  // Preferred path: replace this process image outright. Claude Code inherits
  // our pid, tty, process group and signal handling, and cuckoocode leaves
  // nothing behind — no wrapper process, no exit-code relay, no extra ~40MB of
  // idle Node sitting in your process list for the whole session.
  if (typeof process.execve === 'function' && process.platform !== 'win32') {
    process.execve(bin, [bin, ...args], env)
    return // unreachable: execve never returns on success
  }

  // Fallback for Windows and Node < 23.11, where execve doesn't exist.
  const child = spawn(bin, args, { stdio: 'inherit', env })

  // The child shares our terminal and process group, so the tty delivers
  // SIGINT to it directly. Ignoring it here keeps us from dying first and
  // stranding the child with a detached parent.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})

  child.on('error', (err) => {
    console.error(`cuckoocode: failed to start ${bin}: ${err.message}`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}
