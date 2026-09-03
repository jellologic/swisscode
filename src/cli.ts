import { parseArgv } from './core/args.ts'
import { defaultDeps, LaunchError, main } from './composition/launch-root.ts'

/**
 * `never`, because every path leaves: a LaunchError exits with its own code and
 * anything else is rethrown. Declaring it is what lets `runCli` treat `planned`
 * as assigned after the try/catch below — without it tsc reports a
 * possibly-undefined read on the very next line.
 */
function fail(err: unknown): never {
  if (err instanceof LaunchError) {
    console.error(`swisscode: ${err.message}`)
    process.exit(err.exitCode)
  }
  throw err
}

export async function runCli(argv: string[]): Promise<void> {
  // `--cc-version` BEFORE parsing, and deliberately NOT `--version`.
  //
  // `--version` belongs to the agent. swisscode is a drop-in launcher, and a
  // drop-in that intercepted the target's most common flag would be a trap:
  // `swisscode --version` has always printed Claude Code's version, scripts
  // rely on it, and quietly changing that to print ours would break them for a
  // convenience. The `--cc-` prefix is the reserved namespace that exists for
  // exactly this, so swisscode's own version answers there.
  if (argv[0] === '--cc-version') {
    const { installedVersion } = await import('./adapters/store/fs-version-store.ts')
    console.log(installedVersion() ?? 'unknown')
    return
  }

  // NO ARGUMENTS AT ALL opens the control plane.
  //
  // This is the one deliberate break with the old shape, where a bare
  // `swisscode` launched the default profile or the directory binding. The
  // control plane is where profiles, models, accounts and the gateway are now
  // edited, and it needs a way in that does not spend a word from the reserved
  // namespace — so it takes the empty invocation.
  //
  // Anything at all in argv still launches, so `swisscode -p '...'` and every
  // passthrough form behave exactly as before.
  if (argv.length === 0) {
    const { runControlPlane } = await import('./composition/control-plane-root.ts')
    process.exit(await runControlPlane({ deps: defaultDeps() }))
  }

  const parsed = parseArgv(argv)

  // An unknown --cc-* option, a --cc-model with a bad tier, a repeated
  // --cc-profile. Exit 2 rather than forwarding a reserved-prefix token to
  // claude, where it would read as prompt text while the launch silently used
  // the wrong settings.
  if (parsed.error) {
    console.error(`swisscode: ${parsed.error}`)
    process.exit(2)
  }

  const { command, commandArgs, passthrough, skipOverride, positional, profileFlag, overrides } = parsed

  if (command) {
    // Subcommand dispatch is lazily imported so the launch path's static
    // closure never carries it.
    const { runConfigCommand } = await import('./composition/config-root.ts')
    const code = await runConfigCommand({
      command,
      args: commandArgs,
      deps: defaultDeps(),
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
      'swisscode: several profiles exist and none is set as the default. ' +
        `Run \`swisscode config default <name>\` to choose one. Profiles: ${names}`,
    )
    process.exit(2)
  }

  // Nothing is configured yet. There is no terminal wizard to fall into any
  // more, and guessing a provider would violate the rule against inventing
  // configuration, so this names the one command that can fix it.
  console.error(
    'swisscode: no profiles are configured yet. Run `swisscode` with no ' +
      'arguments to open the control plane and create one.',
  )
  process.exit(2)
}
