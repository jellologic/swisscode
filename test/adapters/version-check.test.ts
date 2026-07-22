// The update notice, end to end, without a network.
//
// The shape being pinned here is the whole design: the LAUNCH PATH MAY NOT ASK
// THE REGISTRY (test/architecture.test.ts forbids fetch there), so it reads a
// file that some earlier config/doctor/web command wrote. These tests exist to
// keep that split from quietly collapsing into "just fetch it at launch".
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERSION_TTL_MS,
  createFsVersionStore,
  installedVersion,
  isStale,
} from '../../src/adapters/store/fs-version-store.ts'
import { fetchLatestVersion } from '../../src/adapters/net/latest-version.ts'
import { detectInstall } from '../../src/composition/config-root.ts'
import { main } from '../../src/composition/launch-root.ts'
import { registry } from '../../src/adapters/providers/registry.ts'
import { registry as agents } from '../../src/adapters/agents/registry.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'swisscode-version-'))

// ── the cache ──

test('a snapshot round-trips, 0600 in a 0700 directory', () => {
  const dir = join(fresh(), 'state')
  const store = createFsVersionStore({ dir })
  store.write({ latest: '0.5.0', checkedAt: 123 })
  assert.deepEqual(store.read(), { latest: '0.5.0', checkedAt: 123 })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'version.json')).mode & 0o777, 0o600)
})

test('a corrupt or partial file reads as absent, never as a version', () => {
  const dir = fresh()
  const store = createFsVersionStore({ dir })
  for (const body of ['', 'not json', '[]', 'null', '{}', '{"latest":""}', '{"latest":"1.0.0"}', '{"checkedAt":1}']) {
    writeFileSync(join(dir, 'version.json'), body)
    assert.equal(store.read(), null, `${JSON.stringify(body)} should read as absent`)
  }
})

test('an unwritable directory does not throw — the command already did its work', () => {
  const parent = fresh()
  const dir = join(parent, 'state')
  const store = createFsVersionStore({ dir })
  store.write({ latest: '0.5.0', checkedAt: 1 })
  // Make it read-only and write again; the failure must be swallowed.
  chmodSync(dir, 0o500)
  try {
    assert.doesNotThrow(() => store.write({ latest: '0.6.0', checkedAt: 2 }))
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('staleness drives whether to spend a request, and a backwards clock counts as stale', () => {
  const now = 1_000_000_000
  assert.equal(isStale(null, now), true, 'never checked')
  assert.equal(isStale({ latest: '1.0.0', checkedAt: now - 1000 }, now), false, 'just checked')
  assert.equal(isStale({ latest: '1.0.0', checkedAt: now - VERSION_TTL_MS - 1 }, now), true)
  // A checkedAt in the future would otherwise read as "definitely fresh" and
  // could wedge the check off permanently.
  assert.equal(isStale({ latest: '1.0.0', checkedAt: now + 60_000 }, now), true)
})

test('the running version is read from the manifest, not baked in', () => {
  // Baked-in constants are exactly the thing that goes stale, and this value's
  // only job is to be compared against the registry.
  const version = installedVersion()
  assert.match(String(version), /^\d+\.\d+\.\d+/)
  assert.equal(version, JSON.parse(readFileSync('package.json', 'utf8')).version)
})

// ── the registry read ──

test('the latest dist-tag is picked out of the abbreviated packument', async () => {
  const seen: { url: string; accept: unknown }[] = []
  const latest = await fetchLatestVersion({
    fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, accept: init.headers.accept })
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '9.9.9' }, versions: {} }) }
    }) as unknown as typeof fetch,
  })
  assert.equal(latest, '9.9.9')
  // The abbreviated form is what npm's own installer asks for: a few kB instead
  // of a few hundred, for one string.
  assert.equal(seen[0]?.accept, 'application/vnd.npm.install-v1+json')
  assert.match(String(seen[0]?.url), /registry\.npmjs\.org\/swisscode$/)
})

test('every registry failure answers null rather than throwing', async () => {
  // This runs as a side errand of a command the user actually asked for. An
  // update check that could fail `config list` would be the worse bug.
  const cases: Array<() => unknown> = [
    () => ({ ok: false, json: async () => ({}) }),
    () => ({ ok: true, json: async () => null }),
    () => ({ ok: true, json: async () => ({}) }),
    () => ({ ok: true, json: async () => ({ 'dist-tags': {} }) }),
    () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: 42 } }) }),
    () => {
      throw new Error('offline')
    },
  ]
  for (const [i, make] of cases.entries()) {
    const got = await fetchLatestVersion({ fetchImpl: (async () => make()) as unknown as typeof fetch })
    assert.equal(got, null, `case ${i} should be null`)
  }
})

// ── install detection ──

test('an ephemeral runner is recognised BEFORE a global install', () => {
  // npx and bun caches both sit inside paths containing "node_modules", so
  // checking for a global install first would misread them and recommend an
  // install the user never asked for.
  assert.equal(detectInstall('/Users/me/.npm/_npx/abc123/node_modules/swisscode/dist/x.js').kind, 'ephemeral')
  assert.equal(detectInstall('/Users/me/.bun/install/cache/swisscode@0.3.0@@@1/dist/x.js').kind, 'ephemeral')
})

test('the bunx note names the stale-cache trap, because that is a real failure', () => {
  // Reproduced against the live registry: bunx served a cached 0.3.0 while npx
  // resolved 0.4.0, and 0.3.0 cannot read a v3 config.
  const bunx = detectInstall('/Users/me/.bun/install/cache/swisscode@0.3.0@@@1/dist/x.js')
  assert.match(bunx.note, /stale/i)
  assert.match(bunx.note, /swisscode@latest/)
  assert.equal(bunx.command, null, 'there is nothing to install for an ephemeral run')
})

test('global installs map to the right package manager', () => {
  assert.equal(
    detectInstall('/usr/local/lib/node_modules/swisscode/dist/x.js').command,
    'npm install -g swisscode',
  )
  assert.equal(detectInstall('/Users/me/.bun/bin/swisscode').command, 'bun install -g swisscode')
})

test('an unrecognised location admits it rather than guessing a command', () => {
  const unknown = detectInstall('/opt/weird/place/swisscode.js')
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.command, null, 'guessing here could run something unexpected on a machine')
})

// ── the notice at launch ──

/** A launch harness whose `replace` records instead of replacing the process. */
function launchHarness(versionStore: ReturnType<typeof createFsVersionStore> | undefined) {
  const reported: string[] = []
  const replaced: string[] = []
  const state = {
    version: 3,
    providerAccounts: { z: { provider: 'zai', apiKey: 'k' } },
    agentProfiles: { z: { models: { opus: 'glm-5.2' } } },
    profiles: { z: { agentProfile: 'z', accounts: ['z'] } },
    defaultProfile: 'z',
    bindings: {},
    settings: {},
  }
  return {
    reported,
    replaced,
    deps: {
      store: {
        load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
        save: () => '/tmp/config.json',
        path: () => '/tmp/config.json',
      },
      registry,
      agents,
      proc: {
        env: () => ({}),
        cwd: () => '/work',
        resolveBinary: () => '/usr/local/bin/claude',
        replace: (bin: string) => {
          replaced.push(bin)
        },
      },
      ...(versionStore ? { version: versionStore } : {}),
    },
    report: (line: string) => reported.push(line),
  }
}

test('a newer cached version produces ONE line, and still launches', async () => {
  const store = createFsVersionStore({ dir: fresh() })
  store.write({ latest: '99.0.0', checkedAt: Date.now() })
  const h = launchHarness(store)
  main({ deps: h.deps as never, report: h.report })

  const notice = h.reported.filter((l) => /is out/.test(l))
  assert.equal(notice.length, 1, 'exactly one notice, not one per warning channel')
  assert.match(notice[0]!, /99\.0\.0/)
  assert.match(notice[0]!, /swisscode config upgrade/)
  // The point of the whole design: it still hands off. A version notice must
  // never be a reason a launch does not happen.
  assert.deepEqual(h.replaced, ['/usr/local/bin/claude'])
})

test('an up-to-date or absent cache says NOTHING', async () => {
  for (const store of [
    createFsVersionStore({ dir: fresh() }), // never written
    (() => {
      const s = createFsVersionStore({ dir: fresh() })
      s.write({ latest: '0.0.1', checkedAt: Date.now() })
      return s
    })(),
    undefined, // nothing wired at all
  ]) {
    const h = launchHarness(store)
    main({ deps: h.deps as never, report: h.report })
    assert.equal(h.reported.filter((l) => /is out/.test(l)).length, 0)
    assert.deepEqual(h.replaced, ['/usr/local/bin/claude'])
  }
})

test('SWISSCODE_QUIET suppresses the notice with everything else', async () => {
  const store = createFsVersionStore({ dir: fresh() })
  store.write({ latest: '99.0.0', checkedAt: Date.now() })
  const h = launchHarness(store)
  h.deps.proc.env = () => ({ SWISSCODE_QUIET: '1' })
  main({ deps: h.deps as never, report: h.report })
  assert.deepEqual(h.reported, [], 'quiet means quiet')
  assert.deepEqual(h.replaced, ['/usr/local/bin/claude'])
})

test('a stale cache still warns — the launcher never refreshes it itself', async () => {
  // Deliberate. The launch path may not reach the network, so a day-old version
  // number is the best it can have, and it is still true enough to warn on.
  const store = createFsVersionStore({ dir: fresh() })
  store.write({ latest: '99.0.0', checkedAt: Date.now() - VERSION_TTL_MS * 30 })
  const h = launchHarness(store)
  main({ deps: h.deps as never, report: h.report })
  assert.equal(h.reported.filter((l) => /is out/.test(l)).length, 1)
})
