// The generated catalog of Claude Code environment variables.
//
// These tests are not about the data — that is extracted and will change with
// every agent release. They are about the ONE PROPERTY that makes shipping 495
// names defensible: nothing carries a description swisscode cannot stand
// behind. A catalog built by reading strings out of a binary is complete on
// names and silent on meaning, and the moment a plausible guess sneaks into a
// description someone acts on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CATALOG_SOURCE,
  CLAUDE_ENV_CATALOG,
} from '../../src/adapters/agents/claude-code/env-catalog.ts'
import { COMPAT_ENV, CREDENTIAL_ENVS } from '../../src/adapters/agents/claude-code/env.ts'

test('the catalog says which agent build it came from', () => {
  // Without provenance this is a list of strings of unknown vintage. The UI
  // prints it, so a reader can tell whether it describes their agent.
  assert.equal(CATALOG_SOURCE.agent, 'claude-code')
  assert.match(CATALOG_SOURCE.version, /^\d+\.\d+\.\d+$/)
  assert.ok(CLAUDE_ENV_CATALOG.length > 100, 'a catalog this small means extraction broke')
})

test('NO ENTRY CARRIES A DESCRIPTION IT DID NOT EARN', () => {
  // The load-bearing test. `documented` is the only kind that may describe
  // itself; everything else must be blank, because the extractor cannot know
  // meaning and a guess is worse than a gap.
  for (const v of CLAUDE_ENV_CATALOG) {
    if (v.kind === 'documented') {
      assert.ok(v.description && v.description.length > 10, `${v.name} is documented but says nothing`)
      assert.ok(v.category, `${v.name} is documented but uncategorised`)
    } else {
      assert.equal(v.description, undefined, `${v.name} is ${v.kind} but carries a description`)
    }
  }
})

test('every internal entry says WHY it is internal', () => {
  // "Internal" is a claim about someone else's software. It has to be
  // falsifiable by a reader, not a shrug.
  for (const v of CLAUDE_ENV_CATALOG.filter((x) => x.kind === 'internal')) {
    assert.ok(v.why && v.why.length > 3, `${v.name} is internal with no reason given`)
  }
})

test('unreleased feature codenames are not offered as knobs', () => {
  // Anthropic ships unreleased work behind two-word codenames. They are
  // indistinguishable from real settings by name, and they appear and vanish
  // between releases — so a user must not be invited to set one.
  const byName = new Map(CLAUDE_ENV_CATALOG.map((v) => [v.name, v]))
  for (const name of ['CLAUDE_CODE_ALDER_WICKET', 'CLAUDE_CODE_BISON_CAIRN', 'CLAUDE_CODE_PEWTER_OWL']) {
    const found = byName.get(name)
    if (!found) continue // a later agent build may drop it; that is fine
    assert.equal(found.kind, 'internal', `${name} should not be presented as a setting`)
    assert.match(String(found.why), /codename/)
  }
})

test('test hooks and cloud-provider auth are not presented as knobs either', () => {
  for (const v of CLAUDE_ENV_CATALOG) {
    if (/_FOR_TESTING$|^CLAUDE_CODE_TEST_/.test(v.name)) {
      assert.equal(v.kind, 'internal', `${v.name} is a test hook`)
    }
    if (/^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)/.test(v.name)) {
      assert.equal(v.kind, 'internal', `${v.name} is third-party cloud auth`)
    }
  }
})

test('every variable swisscode itself sets is in the catalog, described and flagged', () => {
  // The catalog would be actively misleading if it omitted the variables the
  // launcher writes: someone would set one by hand in a profile's `env` block
  // and quietly fight the adapter that already owns it.
  const byName = new Map(CLAUDE_ENV_CATALOG.map((v) => [v.name, v]))
  const ours = [...Object.values(COMPAT_ENV).map((e) => e.env), ...CREDENTIAL_ENVS, 'ANTHROPIC_BASE_URL']
  for (const name of ours) {
    const found = byName.get(name)
    assert.ok(found, `${name} is set by the adapter but missing from the catalog`)
    assert.equal(found.kind, 'documented', `${name} is set by swisscode but undescribed`)
    assert.equal(found.managed, true, `${name} should be flagged as swisscode-managed`)
  }
})

test('names are unique and shaped like environment variables', () => {
  const seen = new Set<string>()
  for (const v of CLAUDE_ENV_CATALOG) {
    assert.ok(!seen.has(v.name), `${v.name} appears twice`)
    seen.add(v.name)
    assert.match(v.name, /^[A-Z][A-Z0-9_]*$/, `${v.name} is not an env var name`)
  }
})

test('the catalog holds no values, only names — it describes, it does not configure', () => {
  // A catalog that carried values would be a second place to configure the
  // agent, competing with profiles. It is documentation.
  for (const v of CLAUDE_ENV_CATALOG) {
    assert.equal((v as Record<string, unknown>).value, undefined)
    assert.equal((v as Record<string, unknown>).default, undefined)
  }
})
