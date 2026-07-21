// Drives the setup wizard end to end with synthetic keystrokes.
// Written with createElement rather than JSX so it runs under plain `node`
// with no build step of its own.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { Profile } from '../src/ports/config-store.ts'

/**
 * dist/ui.js is BUILD OUTPUT. Same treatment as src/cli.ts: tsc must not
 * resolve it, or `npm run typecheck` starts depending on build order and ends
 * up typechecking the compiler's own emit. The contract is stated against the
 * real source instead, via a type query that erases to nothing.
 */
type UiModule = typeof import('../src/composition/ui-root.ts')

const home = mkdtempSync(join(tmpdir(), 'cuckoocode-test-'))
process.env.XDG_CONFIG_HOME = home

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
// @ts-expect-error build artifact, not source — see UiModule above.
const { App }: UiModule = await import('../dist/ui.js')

const h = React.createElement
const DOWN = '\u001B[B'
const ENTER = '\r'
const tick = () => new Promise((r) => setTimeout(r, 60))

let result: Profile | null | undefined
const { lastFrame, stdin } = render(
  h(App, { initial: null, onResult: (cfg: Profile | null) => { result = cfg } }),
)

await tick()
assert.match(lastFrame()!, /Which provider/, 'expected the provider step')
assert.match(lastFrame()!, /z\.ai/, 'expected z.ai in the provider list')
assert.match(lastFrame()!, /ModelScope/, 'expected the ModelScope preset')
assert.match(lastFrame()!, /SiliconFlow/, 'expected the SiliconFlow preset')
assert.doesNotMatch(lastFrame()!, /iFlow|Volcengine/, 'rejected providers must not ship')

stdin.write(DOWN) // anthropic -> z.ai
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame()!, /API key/, 'expected the API key step')
assert.match(lastFrame()!, /ANTHROPIC_AUTH_TOKEN/, 'expected z.ai key env var')

stdin.write('secret-token')
await tick()
assert.doesNotMatch(lastFrame()!, /secret-token/, 'API key must be masked on screen')

stdin.write(ENTER)
await tick()
assert.match(lastFrame()!, /glm-5\.2/, 'expected models prefilled from the provider')
assert.match(lastFrame()!, /fable/, 'expected all four tiers, including fable')

stdin.write(ENTER) // opus
await tick()
stdin.write(ENTER) // sonnet
await tick()
stdin.write(ENTER) // haiku
await tick()
stdin.write(ENTER) // fable
await tick()
assert.match(lastFrame()!, /dangerously-skip-permissions/, 'expected the permissions step')

stdin.write(ENTER) // "yes"
await tick()

assert.ok(result, 'wizard should have produced a profile')
assert.equal(result.provider, 'zai')
assert.equal(result.apiKey, 'secret-token')
assert.equal(result.skipPermissions, true)
// Four tiers, not three: [1m] is read per variable, so a tier the wizard never
// writes is a tier that silently runs at the assumed window.
assert.deepEqual(result.models, {
  opus: 'glm-5.2',
  sonnet: 'glm-5.2',
  haiku: 'glm-5.2',
  fable: 'glm-5.2',
})

const path = join(home, 'cuckoocode', 'config.json')
const saved = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(saved.version, 2, 'wizard must write the v2 profile schema')
assert.equal(saved.defaultProfile, 'zai')
assert.deepEqual(saved.profiles.zai, result, 'the profile must persist verbatim')
assert.equal(statSync(path).mode & 0o777, 0o600, 'the file holds an API key')
assert.equal(statSync(join(home, 'cuckoocode')).mode & 0o777, 0o700)

console.log('ui wizard: all assertions passed')
