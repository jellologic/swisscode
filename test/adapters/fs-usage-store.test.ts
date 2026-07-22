// The measured-usage snapshot, between runs.
//
// Mirrors test/adapters/fs-cursor-store.test.ts, because the discipline is the
// same: best-effort writes, a corrupt file reads as absent, and nothing here may
// fail the command that triggered it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SNAPSHOT_TTL_MS, createFsUsageStore } from '../../src/adapters/store/fs-usage-store.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'swisscode-usage-'))

test('nothing measured yet reads as null, not as empty', () => {
  const store = createFsUsageStore({ dir: join(fresh(), 'never-created') })
  assert.equal(store.read(), null)
})

test('a snapshot round-trips', () => {
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  const snapshot = { remaining: { personal: 27, work: 88 }, checkedAt: Date.now() }
  store.write(snapshot)
  assert.deepEqual(store.read(), snapshot)
})

test('the file is 0600 and the directory 0700 — it maps what you pay for', () => {
  const dir = join(fresh(), 'state')
  const store = createFsUsageStore({ dir })
  store.write({ remaining: { personal: 27 }, checkedAt: Date.now() })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'usage.json')).mode & 0o777, 0o600)
})

test('a snapshot older than the TTL reads as ABSENT, not as zero', () => {
  // A 5-hour window means a figure older than the TTL describes a window that
  // has since rolled over. Selection falls back to the first account and says
  // so, which is better than routing on a number about a different period.
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  store.write({ remaining: { personal: 27 }, checkedAt: Date.now() - SNAPSHOT_TTL_MS - 1 })
  assert.equal(store.read(), null)
})

test('a snapshot just inside the TTL still reads', () => {
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  const checkedAt = Date.now() - SNAPSHOT_TTL_MS + 60_000
  store.write({ remaining: { personal: 27 }, checkedAt })
  assert.equal(store.read()?.checkedAt, checkedAt)
})

test('a corrupt file reads as absent rather than throwing', () => {
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  store.write({ remaining: { personal: 27 }, checkedAt: Date.now() })
  for (const body of ['', 'not json', '[]', 'null', '{"remaining":{}}', '{"remaining":null,"checkedAt":1}']) {
    writeFileSync(join(dir, 'usage.json'), body)
    assert.equal(store.read(), null, `${JSON.stringify(body)} should read as absent`)
  }
})

test('non-numeric entries are DROPPED, never compared against', () => {
  // This map decides which account pays. A hand-edited NaN or string must not
  // enter that comparison.
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  writeFileSync(
    join(dir, 'usage.json'),
    JSON.stringify({
      remaining: { good: 42, nan: Number.NaN, str: '99', nul: null, obj: {} },
      checkedAt: Date.now(),
    }),
  )
  assert.deepEqual(store.read()?.remaining, { good: 42 })
})

test('a snapshot with nothing usable left in it reads as absent', () => {
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  writeFileSync(
    join(dir, 'usage.json'),
    JSON.stringify({ remaining: { bad: 'x' }, checkedAt: Date.now() }),
  )
  assert.equal(store.read(), null)
})

test('an unwritable directory does not throw — the measurement already happened', () => {
  // A REAL read-only directory, matching fs-cursor-store.test.ts.
  //
  // The first version of this used `/proc/nonexistent/...` as a path that
  // "obviously cannot be written". On macOS there is no /proc, so it failed
  // fast with ENOENT and the test passed. ON LINUX `mkdirSync(recursive)`
  // AGAINST THAT PATH HANGS — not throws, hangs, with no output and no exit —
  // which wedged the whole suite in CI. Portable fixtures only.
  const parent = fresh()
  const dir = join(parent, 'state')
  mkdirSync(dir)
  chmodSync(dir, 0o500)
  const store = createFsUsageStore({ dir })
  try {
    assert.doesNotThrow(() => store.write({ remaining: { a: 1 }, checkedAt: Date.now() }))
    assert.equal(store.read(), null)
  } finally {
    // Restored so the temp tree can be cleaned up by whoever cleans /tmp.
    chmodSync(dir, 0o700)
  }
})

test('the file holds no credential — only account names and figures', () => {
  const dir = fresh()
  const store = createFsUsageStore({ dir })
  store.write({ remaining: { personal: 27 }, checkedAt: Date.now() })
  const raw = readFileSync(join(dir, 'usage.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['checkedAt', 'remaining'])
})
