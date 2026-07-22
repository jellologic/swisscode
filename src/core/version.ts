// Is the installed swisscode older than the published one?
//
// Pure, and deliberately the smallest comparison that is correct for THIS
// project's versions rather than a general semver implementation. swisscode
// publishes plain `MAJOR.MINOR.PATCH` — no ranges, no build metadata — and a
// full semver parser on the launch path would be a dependency (forbidden) or a
// few hundred lines of range logic nothing here asks for.
//
// PRERELEASES ARE HANDLED BY BEING IGNORED, explicitly: a version carrying a
// `-` suffix never triggers a notice. Someone running `swisscode@next` opted
// into being ahead, and nagging them to "upgrade" to a lower stable number
// would be both wrong and impossible to act on.

/** `1.2.3` -> [1,2,3]; anything else -> null. */
function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return null
  // `!` on three groups a successful match guarantees.
  return [Number(match[1]!), Number(match[2]!), Number(match[3]!)]
}

/**
 * Whether `latest` is strictly newer than `current`.
 *
 * FALSE IS THE ANSWER FOR EVERYTHING UNCERTAIN — unparseable input on either
 * side, a prerelease, equal versions, or a `latest` that is somehow older.
 * This drives a message that interrupts someone's launch, so the bar is "we are
 * sure", not "we suspect". A missed notice costs nothing; a wrong one trains
 * people to ignore the next.
 */
export function isNewer(latest: string | null | undefined, current: string | null | undefined): boolean {
  if (!latest || !current) return false
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    // `!` — both tuples are fixed length 3.
    if (a[i]! > b[i]!) return true
    if (a[i]! < b[i]!) return false
  }
  return false
}
