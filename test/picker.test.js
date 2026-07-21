// Exercises the model picker: search, filtering, details pane and selection.
// The model cache is pre-seeded so the test is deterministic and needs no
// network.
//
// Two catalogs are driven here on purpose. OpenRouter publishes prices,
// benchmarks and per-model tool support; ModelScope publishes an id list and
// nothing else. The second is what proves the abstraction generalizes — the
// picker has to degrade to honest blanks rather than rendering "$0.00" over
// data it does not have.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'cuckoocode-picker-'))
process.env.XDG_CONFIG_HOME = home
mkdirSync(join(home, 'cuckoocode'), { recursive: true })

const { CACHE_VERSION } = await import('../src/core/catalog.js')

const model = (id, over = {}) => ({
  id,
  name: id,
  description: `Description for ${id}.`,
  context: 200000,
  maxOutput: 64000,
  pricing: { prompt: 0.000003, completion: 0.000015, cacheRead: 0.0000003 },
  benchmarks: null,
  tools: true,
  reasoning: false,
  ...over,
})

const seed = (catalogId, models) =>
  writeFileSync(
    join(home, 'cuckoocode', `models-${catalogId}.json`),
    JSON.stringify({ version: CACHE_VERSION, fetchedAt: Date.now(), models }),
  )

seed('openrouter', [
  model('openrouter/fusion', {
    benchmarks: { intelligence: 61, coding: 74, agentic: 55 },
    context: 1000000,
    pricing: { prompt: 0.000002, completion: 0.000015, cacheRead: 0.0000003 },
  }),
  model('anthropic/claude-opus-4.8', {
    benchmarks: { intelligence: 58, coding: 74.3, agentic: 52 },
  }),
  model('legacy/no-tools-model', { tools: false }),
])

// Exactly what a ModelScope row looks like: an id, and honest nulls.
const msModel = (id, tools = null) => ({
  id,
  name: id,
  description: '',
  context: null,
  maxOutput: null,
  pricing: null,
  benchmarks: null,
  tools,
  reasoning: null,
})

seed('modelscope', [
  msModel('Qwen/Qwen3-235B-A22B-Instruct'),
  msModel('ZhipuAI/GLM-4.6'),
  msModel('deepseek-ai/deepseek-v3.1', false),
])

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
const { App } = await import('../dist/ui.js')

const h = React.createElement
const DOWN = '\u001B[B'
const ENTER = '\r'
const ESC = '\u001B'
const CTRL_T = '\u0014' // ^T
const BACKSPACE = '\u007F'
const tick = () => new Promise((r) => setTimeout(r, 70))

// ---------------------------------------------------- OpenRouter: rich catalog

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
assert.match(lastFrame(), /fable/, 'all four tiers should be offered')

stdin.write(ENTER) // open the picker for opus
await tick()
assert.match(lastFrame(), /model for/, 'expected the picker header')

// esc must return to the tier list, not tear the whole wizard down. The
// picker's footer promises "esc back", and App's own handler used to fire at
// the same time and exit.
stdin.write(ESC)
await tick()
assert.match(lastFrame(), /Pick a model per tier/, 'esc in the picker should go back one step')
assert.equal(result, undefined, 'esc in the picker must not end the wizard')

stdin.write(ENTER) // re-open the picker for opus
await tick()
assert.match(lastFrame(), /model for/, 'expected the picker header again')

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
stdin.write(DOWN) // haiku -> fable
await tick()
stdin.write(DOWN) // fable -> continue
await tick()
stdin.write(ENTER)
await tick()
assert.match(lastFrame(), /dangerously-skip-permissions/, 'expected the permissions step')

stdin.write(ENTER)
await tick()

assert.ok(result, 'wizard should have produced a profile')
assert.equal(result.provider, 'openrouter')
assert.equal(result.models.opus, 'anthropic/claude-opus-4.8', 'picked model must persist')
assert.equal(result.models.sonnet, 'openrouter/fusion', 'untouched tiers keep defaults')
assert.equal(result.models.fable, 'openrouter/fusion', 'the fable tier must not be left unset')

// ------------------------------------------- ModelScope: no prices, no benchmarks

const second = render(h(App, { initial: null, onResult: () => {} }))

await tick()
second.stdin.write(DOWN) // anthropic -> z.ai
await tick()
second.stdin.write(DOWN) // z.ai -> openrouter
await tick()
second.stdin.write(DOWN) // openrouter -> modelscope
await tick()
second.stdin.write(ENTER)
await tick()
assert.match(second.lastFrame(), /API key/, 'expected the API key step')
assert.match(second.lastFrame(), /ms- prefix/, 'the token prefix advice must be on screen')

second.stdin.write('ms-token')
await tick()
second.stdin.write(ENTER)
await tick()
assert.match(second.lastFrame(), /Pick a model per tier/, 'ModelScope should offer the picker too')

second.stdin.write(ENTER) // open the picker for opus
await tick()
const ms = second.lastFrame()

// Rows must render, not come back blank, even with every metric absent.
assert.match(ms, /Qwen\/Qwen3-235B-A22B-Instruct/, 'model ids must still render')
assert.match(ms, /ZhipuAI\/GLM-4\.6/)

// The tools filter is inert here, so nothing is hidden behind a capability the
// catalog never published.
assert.match(ms, /3\/3 shown/, 'a catalog with no tool data must not hide rows')
assert.doesNotMatch(ms, /tools only/, 'the tools filter must be off for this catalog')

// Absent pricing must read as absent, never as free or $0.00.
assert.match(ms, /pricing not published/, 'expected the stated absence')
assert.doesNotMatch(ms, /\$0\.00/, 'unknown pricing must never render as a price')
assert.doesNotMatch(ms, /free/, 'unpriced is not free')
assert.doesNotMatch(ms, /\^F free/, 'the free filter must be hidden for this catalog')
assert.doesNotMatch(ms, /\^T tools/, 'the tools filter must be hidden for this catalog')
assert.doesNotMatch(ms, /artificial analysis/, 'no benchmarks to show')

// Unknown and confirmed-absent tool support must not look the same. Matching
// single-line fragments here on purpose: the details pane wraps, so a phrase
// that spans a line break would never match the rendered frame.
second.stdin.write('deepseek')
await tick()
const probed = second.lastFrame()
assert.match(probed, /· tools/, 'a probed absence renders as a negative badge')
assert.match(probed, /needs tool calling/, 'and as a hard warning')

second.stdin.write(BACKSPACE.repeat(8)) // backspace out the query
await tick()
second.stdin.write('Qwen')
await tick()
const unknown = second.lastFrame()
assert.match(unknown, /\? tools/, 'unknown renders as its own badge, not as "no"')
assert.doesNotMatch(unknown, /needs tool calling/, 'unknown must not read as broken')

console.log('model picker: all assertions passed')
