// Drives the setup wizard end to end with synthetic keystrokes.
// Written with createElement rather than JSX so it runs under plain `node`
// with no build step of its own.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'cuckoocode-test-'))

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
const { App } = await import('../dist/ui.js')

const h = React.createElement
const DOWN = '[B'
const ENTER = '\r'
const tick = () => new Promise((r) => setTimeout(r, 60))

let result
const { lastFrame, stdin } = render(
  h(App, { initial: null, onResult: (cfg) => { result = cfg } }),
)

await tick()
assert.match(lastFrame(), /Which provider/, 'expected the provider step')
assert.match(lastFrame(), /z\.ai/, 'expected z.ai in the provider list')

stdin.write(DOWN) // anthropic -> z.ai
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /API key/, 'expected the API key step')
assert.match(lastFrame(), /ANTHROPIC_AUTH_TOKEN/, 'expected z.ai key env var')

stdin.write('secret-token')
await tick()
assert.doesNotMatch(lastFrame(), /secret-token/, 'API key must be masked on screen')

stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /glm-5\.2/, 'expected models prefilled from the provider')

stdin.write(ENTER) // opus
await tick()
stdin.write(ENTER) // sonnet
await tick()
stdin.write(ENTER) // haiku
await tick()
assert.match(lastFrame(), /dangerously-skip-permissions/, 'expected the permissions step')

stdin.write(ENTER) // "yes"
await tick()

assert.ok(result, 'wizard should have produced a config')
assert.equal(result.provider, 'zai')
assert.equal(result.apiKey, 'secret-token')
assert.equal(result.skipPermissions, true)
assert.deepEqual(result.models, { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' })

const path = join(process.env.XDG_CONFIG_HOME, 'cuckoocode', 'config.json')
assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), result, 'config must persist to disk')

console.log('ui wizard: all assertions passed')
