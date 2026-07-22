// Deciding whether the installed build is behind the published one.
//
// This drives a line that interrupts someone's launch, so the whole point of
// these tests is the NEGATIVE cases: everything uncertain must answer "no".
import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewer } from '../../src/core/version.ts'

test('a strictly greater version is newer, component by component', () => {
  assert.equal(isNewer('0.4.0', '0.3.0'), true)
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  assert.equal(isNewer('0.4.1', '0.4.0'), true)
  assert.equal(isNewer('0.10.0', '0.9.0'), true, 'components compare numerically, not as strings')
})

test('equal or older is NOT newer', () => {
  assert.equal(isNewer('0.4.0', '0.4.0'), false)
  assert.equal(isNewer('0.3.0', '0.4.0'), false)
  assert.equal(isNewer('0.9.0', '0.10.0'), false, 'string comparison would get this wrong')
})

test('a prerelease NEVER triggers a notice, in either position', () => {
  // Someone on `swisscode@next` opted into being ahead. Telling them to
  // "upgrade" to a lower stable number would be wrong and unactionable.
  assert.equal(isNewer('0.5.0-beta.1', '0.4.0'), false)
  assert.equal(isNewer('0.5.0', '0.5.0-beta.1'), false)
})

test('anything unparseable answers no rather than guessing', () => {
  // A missed notice costs nothing. A wrong one trains people to ignore the next.
  for (const [latest, current] of [
    ['', '0.4.0'],
    ['0.4.0', ''],
    ['garbage', '0.4.0'],
    ['0.4.0', 'garbage'],
    ['0.4', '0.3.0'],
    ['v0.5.0', '0.4.0'],
    ['0.4.0.1', '0.4.0'],
  ]) {
    assert.equal(isNewer(latest, current), false, `${latest} vs ${current} should be undecidable`)
  }
})

test('a missing value on either side answers no', () => {
  // Both are real: the cache may hold nothing, and reading the installed
  // version off the manifest can fail.
  assert.equal(isNewer(null, '0.4.0'), false)
  assert.equal(isNewer('0.5.0', null), false)
  assert.equal(isNewer(undefined, undefined), false)
})

test('surrounding whitespace does not defeat the comparison', () => {
  assert.equal(isNewer(' 0.5.0\n', '0.4.0'), true)
})
