// Version comparison for self-update. Pure string logic: no I/O, no deps.
// "Newer" compares leading numeric tuples release-style ("2.1" == "2.1.0");
// a trailing tag ("-rc.1") only breaks a numeric tie, where a bare release
// beats a prerelease. Anything unparseable ("dev", "") is never newer — a
// build that cannot name its version must not claim an update exists.

/** Leading `1.2.3` of a version string, or null when it has none. */
function numericPrefix(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version.trim());
  if (!match) return null;
  return match[1].split(".").map(Number);
}

/** True when text remains after the leading numeric tuple ("-rc.1", "+b"). */
function hasSuffix(version: string): boolean {
  const match = /^v?\d+(?:\.\d+)*/.exec(version.trim());
  return match !== null && match[0].length < version.trim().length;
}

/** True when `latest` names a release newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = numericPrefix(latest);
  const c = numericPrefix(current);
  if (l === null || c === null) return false;
  const width = Math.max(l.length, c.length);
  for (let i = 0; i < width; i++) {
    const diff = (l[i] ?? 0) - (c[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (hasSuffix(latest) === hasSuffix(current)) return false;
  // Numeric tie: the bare release is newer than its own prerelease.
  return !hasSuffix(latest);
}
