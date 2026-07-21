// Exercises the OpenRouter model picker: search, filtering, details pane and
// selection. The model cache is pre-seeded so the test is deterministic and
// needs no network.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'cuckoocode-picker-'))
process.env.XDG_CONFIG_HOME = home
mkdirSync(join(home, 'cuckoocode'), { recursive: true })

const model = (id, over = {}) => ({
  id,
  name: id,
  description: `Description for ${id}.`,
  context: 200000,
  maxOutput: 64000,
  prompt: 0.000003,
  completion: 0.000015,
  cacheRead: 0.0000003,
  tools: true,
  reasoning: false,
  modality: 'text->text',
  aa: null,
  ...over,
})

writeFileSync(
  join(home, 'cuckoocode', 'models-openrouter.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    models: [
      model('openrouter/fusion', {
        aa: { intelligence: 61, coding: 74, agentic: 55 },
        context: 1000000,
        prompt: 0.000002,
      }),
      model('anthropic/claude-opus-4.8', { aa: { intelligence: 58, coding: 74.3, agentic: 52 } }),
      model('legacy/no-tools-model', { tools: false }),
    ],
  }),
)

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
const { App } = await import('../dist/ui.js')

const h = React.createElement
const DOWN = '[B'
const ENTER = '\r'
const CTRL_T = ''
const tick = () => new Promise((r) => setTimeout(r, 70))

let result
const { lastFrame, stdin } = render(
  h(App, { initial: null, onResult: (cfg) => { result = cfg } }),
)

await tick()
stdin.write(DOWN) // anthropic -> z.ai
await tick()
stdin.write(DOWN) // z.ai -> openrouter
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /API key/, 'expected the API key step')

stdin.write('or-key')
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /Pick a model per tier/, 'catalog provider should offer the picker')
assert.match(lastFrame(), /openrouter\/fusion/, 'tier list should show current defaults')

stdin.write(ENTER) // open the picker for opus
await tick()
assert.match(lastFrame(), /model for/, 'expected the picker header')

// tools filter is on by default, so the non-tool model must be hidden
assert.doesNotMatch(lastFrame(), /no-tools-model/, 'tools filter should hide unusable models')
assert.match(lastFrame(), /2\/3 shown/, 'expected 2 of 3 models visible')
assert.match(lastFrame(), /tools only/, 'expected the tools-only indicator')

stdin.write(CTRL_T) // toggle the filter off
await tick()
assert.match(lastFrame(), /3\/3 shown/, 'ctrl-T should reveal all models')
assert.match(lastFrame(), /no-tools-model/, 'unfiltered list should include it')

stdin.write(CTRL_T) // back on
await tick()

// details pane content for the highlighted model
assert.match(lastFrame(), /\$2\.00/, 'expected input price per M tokens')
assert.match(lastFrame(), /1M/, 'expected formatted context length')
assert.match(lastFrame(), /coding/, 'expected the benchmark rows')

// search narrows the list
stdin.write('claude')
await tick()
assert.match(lastFrame(), /1\/3 shown/, 'search should narrow to one match')
assert.match(lastFrame(), /claude-opus-4\.8/, 'expected the searched model')
assert.doesNotMatch(lastFrame(), /› {2}openrouter\/fusion/, 'fusion should be filtered out')

stdin.write(ENTER) // select it
await tick()
assert.match(lastFrame(), /Pick a model per tier/, 'should return to the tier list')
assert.match(lastFrame(), /opus {4}anthropic\/claude-opus-4\.8/, 'opus should now be set')

stdin.write(DOWN) // opus -> sonnet
await tick()
stdin.write(DOWN) // sonnet -> haiku
await tick()
stdin.write(DOWN) // haiku -> continue
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /dangerously-skip-permissions/, 'expected the permissions step')

stdin.write(ENTER)
await tick()

assert.ok(result, 'wizard should have produced a config')
assert.equal(result.provider, 'openrouter')
assert.equal(result.models.opus, 'anthropic/claude-opus-4.8', 'picked model must persist')
assert.equal(result.models.sonnet, 'openrouter/fusion', 'untouched tiers keep defaults')

console.log('model picker: all assertions passed')
