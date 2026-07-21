import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Executable-file test.
 *
 * The mode check is skipped on Windows: NTFS has no execute bit and Node
 * reports 0o666 / 0o444 there, so `mode & 0o111` is always 0 and every
 * candidate would be rejected — which made the spawn fallback that exists for
 * Windows unreachable.
 */
export function makeIsExecutable(platform) {
  return function isExecutableFile(p) {
    try {
      const s = statSync(p)
      if (!s.isFile()) return false
      if (platform === 'win32') return true
      return (s.mode & 0o111) !== 0
    } catch {
      return false
    }
  }
}

/** Candidate filenames for `name` on this platform, honouring PATHEXT. */
export function candidateNames(name, platform, pathExtEnv) {
  if (platform !== 'win32') return [name]
  const exts = (pathExtEnv ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
  // The bare name first: a shim installed without an extension still wins if
  // it is genuinely there.
  return [name, ...exts.map((e) => name + e)]
}

/**
 * Pure resolution logic with the filesystem injected, so PATHEXT parsing and
 * the Windows mode-check skip are unit-testable off Windows.
 *
 * PATH order is intentional: inside a wrapper environment (cmux, devcontainer
 * shims) the earlier entry is the one `env` expects to be used.
 */
export function findBinary({
  name = 'claude',
  pathEnv = '',
  pathExt = null,
  platform = 'linux',
  fallbacks = [],
  isExecutable,
  isSelf,
}) {
  const names = candidateNames(name, platform, pathExt)
  // Not node:path's `delimiter`: that reflects the HOST platform, so resolving
  // a Windows PATH would split "C:\tools" on the colon.
  const pathSeparator = platform === 'win32' ? ';' : ':'
  // Likewise for the separator: node:path's join would build a POSIX path when
  // this logic is exercised for win32 from a POSIX host.
  const dirSeparator = platform === 'win32' ? '\\' : '/'
  const joinPath = (dir, file) =>
    dir.endsWith(dirSeparator) ? dir + file : dir + dirSeparator + file
  let skippedSelf = false

  for (const dir of pathEnv.split(pathSeparator)) {
    if (!dir) continue
    for (const candidate of names.map((n) => joinPath(dir, n))) {
      if (!isExecutable(candidate)) continue
      if (isSelf(candidate)) {
        skippedSelf = true
        continue
      }
      return { bin: candidate, skippedSelf }
    }
  }

  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !isSelf(candidate)) return { bin: candidate, skippedSelf }
  }

  return { bin: null, skippedSelf }
}

export function defaultFallbacks(home) {
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
}

/**
 * @param {{env?:Record<string,string>, platform?:string, selfDir?:string}} [opts]
 * @returns {import('../../ports/process.js').ProcessPort}
 */
export function createNodeProcess({
  env = process.env,
  platform = process.platform,
  selfDir = null,
} = {}) {
  const SELF_DIR =
    selfDir ??
    (() => {
      try {
        return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
      } catch {
        return null
      }
    })()

  const isExecutable = makeIsExecutable(platform)

  // Guards `alias claude=cuckoocode` and a global shim pointing back at us,
  // which would otherwise recurse until the machine gives up. sep, not '/',
  // or the prefix never matches on Windows.
  function isSelf(p) {
    if (!SELF_DIR) return false
    try {
      const real = realpathSync(p)
      return real === SELF_DIR || real.startsWith(SELF_DIR + sep)
    } catch {
      return false
    }
  }

  function resolveBinary() {
    const override = env.CUCKOOCODE_CLAUDE_BIN
    if (override) {
      if (!isExecutable(override)) {
        throw new Error(
          `CUCKOOCODE_CLAUDE_BIN is set to "${override}", which is not an executable file.`,
        )
      }
      // The override was unguarded, so pointing it at cuckoocode produced an
      // infinite chain of execve calls that presents as a hang, not an error.
      if (isSelf(override)) {
        throw new Error(
          `CUCKOOCODE_CLAUDE_BIN points at cuckoocode itself ("${override}"). ` +
            'Point it at the real claude binary.',
        )
      }
      return override
    }

    const { bin, skippedSelf } = findBinary({
      name: 'claude',
      pathEnv: env.PATH || '',
      pathExt: env.PATHEXT ?? null,
      platform,
      fallbacks: defaultFallbacks(env.HOME || homedir()),
      isExecutable,
      isSelf,
    })
    if (bin) return bin

    throw new Error(
      skippedSelf
        ? 'the only `claude` on your PATH is cuckoocode itself. Point CUCKOOCODE_CLAUDE_BIN at the real binary.'
        : 'could not find the `claude` binary on your PATH. Install Claude Code, or set CUCKOOCODE_CLAUDE_BIN.',
    )
  }

  function replace(bin, args, childEnv) {
    // Preferred path: replace this process image outright. Claude Code inherits
    // our pid, tty, process group and signal handling, and cuckoocode leaves
    // nothing behind — no wrapper process, no exit-code relay, no extra idle
    // Node sitting in the process list for the whole session.
    if (typeof process.execve === 'function' && platform !== 'win32') {
      try {
        process.execve(bin, [bin, ...args], childEnv)
        return // unreachable: execve never returns on success
      } catch (err) {
        // execve existing is not the same as execve working: EACCES, a TOCTOU
        // ENOENT, ETXTBSY and ERR_FEATURE_UNAVAILABLE_ON_PLATFORM all throw
        // here. Falling through to spawn beats dying.
        if (process.env.CUCKOOCODE_DEBUG) {
          console.error(`cuckoocode: execve failed (${err.message}); falling back to spawn.`)
        }
      }
    }

    spawnFallback(bin, args, childEnv)
  }

  return {
    env: () => ({ ...env }),
    cwd: () => process.cwd(),
    resolveBinary,
    replace,
  }
}

/** Fallback for Windows and Node < 23.11, where execve does not exist. */
export function spawnFallback(bin, args, childEnv, host = process) {
  const child = spawn(bin, args, { stdio: 'inherit', env: childEnv })

  // The child shares our terminal and process group, so the tty delivers SIGINT
  // to it directly. Ignoring it here keeps us from dying first and stranding
  // the child with a detached parent.
  const onSignal = () => {}
  host.on('SIGINT', onSignal)
  host.on('SIGTERM', onSignal)

  child.on('error', (err) => {
    console.error(`cuckoocode: failed to start ${bin}: ${err.message}`)
    host.exit(127)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raising while our own no-op handler is still installed makes the
      // signal inert, so a signal-killed claude reported exit 0 to the shell.
      // Every Node 22 user takes this path, because execve needs 23.11+.
      host.removeAllListeners('SIGINT')
      host.removeAllListeners('SIGTERM')
      host.kill(host.pid, signal)
      return
    }
    host.exit(code ?? 0)
  })

  return child
}

/**
 * Path-independent recursion guard. buildEnv has always written CUCKOOCODE=1
 * into the child environment and nothing ever read it; reading it catches the
 * cases realpath cannot, such as a shell shim that runs `exec cuckoocode "$@"`.
 */
export function detectRecursion(ambientEnv) {
  return ambientEnv?.CUCKOOCODE === '1'
}
