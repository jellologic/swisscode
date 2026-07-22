import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsConfigStore } from '../../src/adapters/store/fs-config-store.ts'
import { makeProfile } from '../support/fixtures.ts'

/** Byte-for-byte what swisscode 0.1.0's saveConfig writes. */
const V1_ON_DISK = `${JSON.stringify(
  {
    provider: 'zai',
    apiKey: 'zai-secret-key',
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' },
    skipPermissions: true,
  },
  null,
  2,
)}\n`

function freshHome(contents: string | null = null, mode = 0o600) {
  const home = mkdtempSync(join(tmpdir(), 'swisscode-store-'))
  const dir = join(home, 'swisscode')
  if (contents !== null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'config.json'), contents, { mode })
    chmodSync(join(dir, 'config.json'), mode)
  }
  return { home, dir, store: createFsConfigStore({ dir }) }
}

test('a missing config yields an empty state and writes nothing', () => {
  const { dir, store } = freshHome()
  const loaded = store.load()
  assert.deepEqual(loaded.state.profiles, {})
  assert.equal(loaded.corrupt, false)
  // A launch that only reads must not touch the disk.
  assert.equal(existsSync(join(dir, 'config.json')), false)
})

test('a real 0.1.0 config file migrates automatically on load', () => {
  const { dir, store } = freshHome(V1_ON_DISK)
  const loaded = store.load()

  assert.equal(loaded.migrated, true)
  assert.equal(loaded.state.version, 3)
  assert.equal(loaded.state.defaultProfile, 'zai')
  assert.deepEqual(loaded.state.providerAccounts.zai, {
    provider: 'zai',
    apiKey: 'zai-secret-key',
  })
  assert.deepEqual(loaded.state.agentProfiles.zai, {
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' },
    skipPermissions: true,
  })

  // Persisted, and the original kept beside it.
  const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(onDisk.version, 3)
  assert.equal(onDisk.providerAccounts.zai.apiKey, 'zai-secret-key')
  assert.equal(readFileSync(join(dir, 'config.v1.bak.json'), 'utf8'), V1_ON_DISK)
  assert.ok(loaded.warnings.some((w) => w.includes('migrated')))
})

test('migrating twice does not clobber the original backup', () => {
  const { dir } = freshHome(V1_ON_DISK)
  createFsConfigStore({ dir }).load()
  const backup = readFileSync(join(dir, 'config.v1.bak.json'), 'utf8')
  // Second run reads a v2 file and must be a no-op.
  const second = createFsConfigStore({ dir }).load()
  assert.equal(second.migrated, false)
  assert.equal(readFileSync(join(dir, 'config.v1.bak.json'), 'utf8'), backup)
})

test('the migrated file keeps 0600 in a 0700 directory', () => {
  const { dir } = freshHome(V1_ON_DISK, 0o644)
  chmodSync(dir, 0o755)
  createFsConfigStore({ dir }).load()
  // mkdirSync's mode only applies on create, and writeFileSync's only on
  // create. Both have to be re-asserted; this file holds an API key.
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600)
})

test('save writes 0600 in 0700 even when the directory did not exist', () => {
  const { dir, store } = freshHome()
  store.save({
    version: 3,
    providerAccounts: { a: { provider: 'zai' } },
    agentProfiles: { a: {} },
    profiles: { a: { agentProfile: 'a', accounts: ['a'] } },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
  })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600)
})

test('save leaves no temp file behind', () => {
  const { dir, store } = freshHome()
  store.save({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} })
  assert.deepEqual(readdirSync(dir), ['config.json'])
})

test('a truncated config is quarantined rather than overwritten in place', () => {
  const { dir, store } = freshHome('{"provider": "zai", "apiK')
  const loaded = store.load()
  assert.equal(loaded.corrupt, true)
  assert.deepEqual(loaded.state.profiles, {})
  // Still on disk: nothing has been written yet.
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"provider": "zai", "apiK')

  store.save({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} })
  const quarantined = readdirSync(dir).filter((f) => f.startsWith('config.corrupt-'))
  assert.equal(quarantined.length, 1)
  assert.equal(readFileSync(join(dir, quarantined[0]!), 'utf8'), '{"provider": "zai", "apiK')
})

test('a quarantine that cannot rename aborts save() instead of destroying the corrupt config', () => {
  const { dir, store } = freshHome('{"provider": "zai", "apiK')
  assert.equal(store.load().corrupt, true)
  // A read-only directory makes renameSync fail (rename needs write perm on the
  // dir). save() must throw rather than overwrite the unparseable, key-bearing file.
  chmodSync(dir, 0o500)
  try {
    assert.throws(
      () => store.save({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} }),
      /could not move it aside|refusing to overwrite/,
    )
    chmodSync(dir, 0o700)
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"provider": "zai", "apiK')
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('config.corrupt-')).length, 0)
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('a NEWER schema is read but never written back', () => {
  const future = `${JSON.stringify({
    version: 99,
    providerAccounts: { a: { provider: 'zai', apiKey: 'k' } },
    agentProfiles: { a: {} },
    profiles: { a: { agentProfile: 'a', accounts: ['a'] } },
    defaultProfile: 'a',
  })}\n`
  const { dir, store } = freshHome(future)
  const loaded = store.load()

  assert.equal(loaded.readOnly, true)
  assert.equal(loaded.state.providerAccounts.a!.provider, 'zai')
  assert.ok(loaded.warnings.some((w) => w.includes('version 99')))

  const before = statSync(join(dir, 'config.json')).mtimeMs
  assert.throws(() => store.save(loaded.state), /refusing to overwrite/)
  assert.equal(statSync(join(dir, 'config.json')).mtimeMs, before)
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), future)
})

test('a failed migration write does not block the launch', () => {
  // Note on how this failure is induced: dropping the directory's write bit is
  // NOT enough, because the store re-asserts 0700 on the way in and the owner
  // is always allowed to chmod their own directory. That re-assertion is
  // required by the "0600 in 0700, always" rule, so the realistic failures here
  // are the ones an fs mode cannot express — a read-only mount, EACCES from a
  // different uid, NFS. Blocking the temp path reproduces the same code path
  // deterministically.
  const { dir, store } = freshHome(V1_ON_DISK)
  mkdirSync(join(dir, `config.json.tmp.${process.pid}`), { recursive: true })

  const loaded = store.load()

  // The migrated settings are still usable in memory, and the launch proceeds.
  assert.equal(loaded.state.version, 3)
  assert.equal(loaded.state.providerAccounts.zai!.provider, 'zai')
  assert.equal(loaded.state.providerAccounts.zai!.apiKey, 'zai-secret-key')
  assert.ok(loaded.warnings.some((w) => w.includes('could not rewrite')))
  // The original file is untouched, so the next run can migrate it again.
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), V1_ON_DISK)
})

test('the 0700 directory mode is re-asserted even on a loose existing dir', () => {
  const { dir, store } = freshHome(V1_ON_DISK, 0o644)
  chmodSync(dir, 0o755)
  store.load()
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('unknown top-level keys survive a round trip', () => {
  const withExtra = `${JSON.stringify({
    version: 3,
    providerAccounts: { a: { provider: 'zai' } },
    agentProfiles: { a: {} },
    profiles: { a: { agentProfile: 'a', accounts: ['a'], futureField: 1 } },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
    somethingNewer: { keep: true },
  })}\n`
  const { dir, store } = freshHome(withExtra)
  const loaded = store.load()
  store.save(loaded.state)
  const round = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(round.somethingNewer, { keep: true })
  assert.equal(round.profiles.a.futureField, 1)
})

test('a v1 config whose provider is no longer known still migrates', () => {
  const { store } = freshHome(`${JSON.stringify(makeProfile({ provider: 'volcengine', apiKey: 'k' }))}\n`)
  const loaded = store.load()
  assert.equal(loaded.state.providerAccounts.volcengine!.provider, 'volcengine')
})

// revision(): lost-update detection for long-lived editors (the web UI).

test('revision is null when there is no file, and a string once there is', () => {
  // "No config yet" is itself a revision worth quoting back: a caller that read
  // an empty state and then saves must still be told if someone created one in
  // the meantime.
  const { store } = freshHome()
  assert.equal(store.revision!(), null)
  store.save({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} })
  assert.equal(typeof store.revision!(), 'string')
})

test('revision follows CONTENT, not the clock', () => {
  // Deliberately not mtime. Its granularity is coarse and platform-dependent,
  // so two writes inside one tick can share a timestamp — a lost update would
  // slip through exactly when writers are most concurrent. Hashing bytes cannot
  // have that failure, and this test is what pins the choice.
  const { store } = freshHome()
  const base = { version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} }

  store.save(base)
  const first = store.revision!()

  // Same content written again, immediately: same revision.
  store.save(base)
  assert.equal(store.revision!(), first, 'identical content changed the revision')

  // Different content, also immediately: different revision.
  store.save({ ...base, defaultProfile: 'work', profiles: { work: { provider: 'zai' } } } as never)
  assert.notEqual(store.revision!(), first, 'a real edit did not change the revision')
})

test('an edit made behind our back is visible as a revision change', () => {
  // The interleaving this exists to catch: read, wait, and meanwhile another
  // swisscode command writes.
  const { dir, store } = freshHome()
  store.save({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: null, bindings: {}, settings: {} })
  const held = store.revision!()

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, providerAccounts: {}, agentProfiles: {}, profiles: {}, defaultProfile: 'other', bindings: {}, settings: {} }))
  assert.notEqual(store.revision!(), held)
})
