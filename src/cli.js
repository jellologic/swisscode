import { parseArgv } from './core/args.js'
import { defaultDeps, LaunchError, main } from './composition/launch-root.js'

/**
 * The Ink UI is imported lazily and only from here. bin/cuckoocode.js and
 * everything the launch path reaches stays plain dependency-free JS, so a
 * normal launch never pays for loading React.
 */
async function openUi(mode, options) {
  let ui
  try {
    ui = await import('../dist/ui.js')
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('UI bundle is missing. Run `npm run build` in the cuckoocode checkout.')
    }
    throw err
  }
  return ui.runUi({ mode, ...options })
}

function fail(err) {
  if (err instanceof LaunchError) {
    console.error(`cuckoocode: ${err.message}`)
    process.exit(err.exitCode)
  }
  throw err
}

export async function runCli(argv) {
  const parsed = parseArgv(argv)

  // An unknown --cc-* option, a --cc-model with a bad tier, a repeated
  // --cc-profile. Exit 2 rather than forwarding a reserved-prefix token to
  // claude, where it would read as prompt text while the launch silently used
  // the wrong settings.
  if (parsed.error) {
    console.error(`cuckoocode: ${parsed.error}`)
    process.exit(2)
  }

  const { command, commandArgs, passthrough, skipOverride, positional, profileFlag, overrides } = parsed

  if (command) {
    // Subcommand dispatch is lazily imported so the launch path's static
    // closure never carries it.
    const { runConfigCommand } = await import('./composition/config-root.js')
    const code = await runConfigCommand({
      command,
      args: commandArgs,
      deps: defaultDeps(),
      openUi,
    })
    if (code !== 0) process.exit(code)
    return
  }

  const launchArgs = { passthrough, skipOverride, positional, profileFlag, overrides }

  let planned
  try {
    planned = main({ ...launchArgs, deps: defaultDeps() })
  } catch (err) {
    fail(err)
  }

  // Nothing below runs on a successful launch: execve replaced this process,
  // and the spawn fallback ends in an exit relay.
  if (!planned?.needsSetup) return

  if (planned.selection.ambiguous) {
    const names = Object.keys(planned.loaded.state.profiles).join(', ')
    console.error(
      'cuckoocode: several profiles exist and none is set as the default. ' +
        `Run \`cuckoocode config default <name>\` to choose one. Profiles: ${names}`,
    )
    process.exit(2)
  }

  const saved = await openUi('setup', { state: planned.loaded.state })
  if (!saved) {
    console.error('cuckoocode: setup cancelled, nothing launched.')
    process.exit(1)
  }

  // Re-read from disk so the launch uses exactly what was persisted.
  try {
    main({ ...launchArgs, deps: defaultDeps() })
  } catch (err) {
    fail(err)
  }
}
