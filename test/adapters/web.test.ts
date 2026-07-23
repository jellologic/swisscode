// The web UI's gate and API.
//
// The gate gets the most attention in this file, and deliberately: it stands in
// front of a server that can read and write a file holding plaintext API keys,
// reachable by any page the user has open in the same browser. "It only listens
// on localhost" is the reason a security model is needed, not a substitute for
// one.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SECURITY_HEADERS,
  documentSecurityHeaders,
  inlineScriptHashes,
  TOKEN_HEADER,
  allowedHosts,
  checkHost,
  checkOrigin,
  guardApiRequest,
  guardDocumentRequest,
  tokensMatch,
} from '../../src/adapters/web/security.ts'
import { CONFLICT_REASON } from '../../src/core/account.ts'
import { handleApi, parseAccount, parseAgentProfile, redactAccount, redactState } from '../../src/adapters/web/api.ts'
import { FALLBACK_SCRIPT_PATH, resolveAsset, startWebServer } from '../../src/adapters/web/server.ts'
import { request } from 'node:http'
import { registry as providers } from '../../src/adapters/providers/registry.ts'
import { registry as agents } from '../../src/adapters/agents/registry.ts'
import { makeAccount, makeAgentProfile, makeProfile } from '../support/fixtures.ts'
import type { ConfigStorePort, State } from '../../src/ports/config-store.ts'

const PORT = 4242
const TOKEN = 'a'.repeat(64)
const sec = { token: TOKEN, port: PORT }

// the gate

test('DNS rebinding is refused at the Host header', () => {
  // The whole attack: the connection genuinely comes from loopback, so no
  // socket-level check can tell it apart. Only the Host header can.
  const v = checkHost('evil.example', PORT)
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.match(v.reason, /rebinding/)
})

test('the Host allowlist is exact, not a suffix or substring match', () => {
  for (const host of allowedHosts(PORT)) assert.equal(checkHost(host, PORT).ok, true)
  // Each of these would pass a naive `includes`/`endsWith` check.
  for (const bad of [
    '127.0.0.1.evil.example:4242',
    'evil.example?127.0.0.1:4242',
    'localhost:4243',
    'notlocalhost:4242',
    '127.0.0.1',
  ]) {
    assert.equal(checkHost(bad, PORT).ok, false, `${bad} was accepted`)
  }
})

test('a wrong Origin is refused; an absent one is not', () => {
  assert.equal(checkOrigin('https://evil.example', PORT).ok, false)
  assert.equal(checkOrigin(`http://127.0.0.1:${PORT}`, PORT).ok, true)
  // Some browsers omit Origin on same-origin GETs, so absent cannot be fatal
  // without breaking ordinary navigation.
  assert.equal(checkOrigin(undefined, PORT).ok, true)
})

test('the token comparison does not short-circuit on the first wrong byte', () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true)
  assert.equal(tokensMatch('b' + TOKEN.slice(1), TOKEN), false)
  assert.equal(tokensMatch(TOKEN.slice(0, -1) + 'b', TOKEN), false)
  assert.equal(tokensMatch(TOKEN.slice(0, 10), TOKEN), false)
  assert.equal(tokensMatch(undefined, TOKEN), false)
})

test('an API request needs all three: Host, Origin and token', () => {
  const good = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, token: TOKEN }
  assert.equal(guardApiRequest(good, sec).ok, true)
  assert.equal(guardApiRequest({ ...good, host: 'evil.example' }, sec).ok, false)
  assert.equal(guardApiRequest({ ...good, origin: 'https://evil.example' }, sec).ok, false)
  assert.equal(guardApiRequest({ ...good, token: 'wrong' }, sec).ok, false)
  assert.equal(guardApiRequest({ ...good, token: undefined }, sec).ok, false)
})

test('the document is exempt from the token but not from Host', () => {
  // Circular otherwise: the document is what delivers the token. Safe because
  // it carries only markup and that token, and cannot be read cross-origin.
  assert.equal(guardDocumentRequest({ host: `localhost:${PORT}` }, { port: PORT }).ok, true)
  assert.equal(guardDocumentRequest({ host: 'evil.example' }, { port: PORT }).ok, false)
})

test('the CSP forbids inline script and framing', () => {
  const csp = SECURITY_HEADERS['content-security-policy']!
  assert.match(csp, /script-src 'self'/)
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
  assert.match(csp, /frame-ancestors 'none'/)
  // The document carries the session token; a disk cache would outlive it.
  assert.equal(SECURITY_HEADERS['cache-control'], 'no-store')
})

test('path traversal cannot escape the asset directory', () => {
  const root = '/tmp/swisscode-assets'
  for (const p of ['/../../etc/passwd', '/..%2f..%2fetc/passwd', '/subdir/../../../etc/passwd']) {
    assert.equal(resolveAsset(root, p), null, `${p} escaped the root`)
  }
})

// redaction

test('an API key never crosses the boundary to the browser', () => {
  // Redaction moved to the ACCOUNT with the credential. That is an improvement:
  // one of the three shapes is security-sensitive and it is obvious which.
  const account = makeAccount(makeProfile({ provider: 'zai', apiKey: 'sk-super-secret' }))
  const out = redactAccount(account)
  const serialized = JSON.stringify(out)
  assert.ok(!serialized.includes('sk-super-secret'), 'the key leaked')
  assert.ok(!serialized.includes('sk-super'), 'a prefix of the key leaked')
  assert.equal(out.hasKey, true)
  assert.ok(!('apiKey' in out))

  // A variable NAME is not a secret, and the user needs to see it.
  const fromEnv = redactAccount(makeAccount({ provider: 'zai', apiKeyFromEnv: 'MY_TOKEN' }))
  assert.equal(fromEnv.apiKeyFromEnv, 'MY_TOKEN')
  assert.equal(fromEnv.hasKey, false)
})

// api

function store(initial: State): ConfigStorePort & { state: State; saves: number } {
  let current = initial
  let saves = 0
  return {
    get state() {
      return current
    },
    get saves() {
      return saves
    },
    load: () => ({ state: current, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
    save: (s: State) => {
      current = s
      saves++
      return '/tmp/config.json'
    },
    path: () => '/tmp/config.json',
    // Content-derived, like the real one, so the conflict tests are honest.
    revision: () => JSON.stringify(current).length.toString(36) + ':' + saves,
  }
}

const baseState = (): State =>
  ({
    version: 2,    providerAccounts: {
      work: makeProfile({ provider: 'zai', apiKey: 'secret' }),
    },
    agentProfiles: {
      work: { models: {} },
    },
    profiles: {
      work: { agentProfile: 'work', accounts: ['work'] },
    },
    defaultProfile: 'work',
    bindings: {},
    settings: {},
  }) as unknown as State

const deps = (s: ConfigStorePort) => ({ store: s, providers, agents })

test('bootstrap hands the UI everything it needs, minus the keys', () => {
  const s = store(baseState())
  const res = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, deps(s))
  assert.equal(res.status, 200)
  const body = res.body as Record<string, unknown>
  assert.ok(!JSON.stringify(body).includes('secret'), 'a key reached the browser payload')
  assert.ok(Array.isArray(body.providers))
  assert.ok((body.providers as unknown[]).length >= 8, 'providers are listed for the picker')
  assert.equal(typeof body.revision, 'string')
})

test('a write without a revision is refused rather than allowed to stomp', () => {
  const s = store(baseState())
  const res = handleApi(
    { method: 'PUT', path: '/api/profiles/acme', body: { profile: { provider: 'zai' } } },
    deps(s),
  )
  assert.equal(res.status, 400)
  assert.equal(s.saves, 0)
})

test('a stale revision is a 409, not a silent overwrite', () => {
  const s = store(baseState())
  const res = handleApi(
    {
      method: 'PUT',
      path: '/api/profiles/acme',
      body: { revision: 'stale', profile: { provider: 'zai' } },
    },
    deps(s),
  )
  assert.equal(res.status, 409)
  assert.match(String((res.body as { error: string }).error), /changed since you loaded it/)
  assert.equal(s.saves, 0, 'a conflicting write must not reach the store')
})

test('a current revision writes, and returns the next one', () => {
  const s = store(baseState())
  const res = handleApi(
    {
      method: 'PUT',
      path: '/api/accounts/acme',
      body: { revision: s.revision!(), account: { provider: 'openrouter' } },
    },
    deps(s),
  )
  assert.equal(res.status, 200)
  assert.equal(s.state.providerAccounts.acme!.provider, 'openrouter')
  assert.notEqual((res.body as { revision: string }).revision, 'stale')
})

test('an omitted key does not erase the stored one; an explicit null does', () => {
  // The single most destructive mistake this endpoint could make is treating an
  // untouched form field as "delete my credential".
  const existing = makeAccount(makeProfile({ provider: 'zai', apiKey: 'keep-me' }))
  const kept = parseAccount(makeProfile({ provider: 'zai' }), existing)
  assert.equal(typeof kept === 'string' ? null : kept.apiKey, 'keep-me')

  const blanked = parseAccount(makeProfile({ provider: 'zai', apiKey: '' }), existing)
  assert.equal(typeof blanked === 'string' ? null : blanked.apiKey, 'keep-me')

  const cleared = parseAccount({ provider: 'zai', apiKey: null }, existing)
  assert.equal(typeof cleared === 'string' ? undefined : cleared.apiKey, undefined)
})

test('unknown fields from the client never reach config.json', () => {
  const parsed = parseAccount(
    { provider: 'zai', evil: 'payload', __proto__: { polluted: true } },
    undefined,
  )
  assert.notEqual(typeof parsed, 'string')
  assert.ok(!('evil' in (parsed as object)))
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'prototype was polluted')
})

test('an invalid profile name is refused with the CLI’s own reason', () => {
  const s = store(baseState())
  const res = handleApi(
    {
      method: 'PUT',
      path: '/api/profiles/not%20valid',
      body: { revision: s.revision!(), profile: { provider: 'zai' } },
    },
    deps(s),
  )
  assert.equal(res.status, 400)
  assert.equal(s.saves, 0)
})

test('deleting a profile prunes its bindings and clears the default', () => {
  const s = store({
    ...baseState(),
    bindings: { '/work/repo': 'work' },
  } as unknown as State)
  const res = handleApi(
    { method: 'DELETE', path: '/api/profiles/work', body: { revision: s.revision!() } },
    deps(s),
  )
  assert.equal(res.status, 200)
  assert.equal(s.state.profiles.work, undefined)
  assert.deepEqual(s.state.bindings, {}, 'a binding to a deleted profile would silently fall back')
  assert.equal(s.state.defaultProfile, null)
})

// end to end, over a real socket

/** A raw GET that can set headers fetch() forbids — Host being the one at issue. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolveRaw({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', rejectRaw)
    req.end()
  })
}

test('the live server refuses a rebound Host and serves with the token', async () => {
  const s = store(baseState())
  const server = await startWebServer({ ...deps(s), port: 0 })
  try {
    const base = `http://127.0.0.1:${server.port}`

    // Host is a FORBIDDEN header for fetch(), which silently pins it from the
    // URL — so the rebinding case is unreachable through fetch and has to go
    // over a raw request. Asserting it via fetch would have been a test that
    // could never fail.
    const rebound = await rawGet(server.port, '/api/bootstrap', {
      host: 'evil.example',
      [TOKEN_HEADER]: server.token,
    })
    assert.equal(rebound.status, 403, 'a rebound Host reached the API')
    assert.match(rebound.body, /rebinding/)

    const noToken = await fetch(`${base}/api/bootstrap`)
    assert.equal(noToken.status, 401)

    const ok = await fetch(`${base}/api/bootstrap`, {
      headers: { [TOKEN_HEADER]: server.token },
    })
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as { state: { profiles: Record<string, unknown> } }
    assert.ok(Object.keys(body.state.profiles).includes('work'))
    assert.ok(!JSON.stringify(body).includes('secret'), 'the key went over the wire')

    const doc = await fetch(`${base}/`)
    assert.equal(doc.status, 200)
    const html = await doc.text()
    assert.match(html, /swisscode-token/)
    assert.equal(doc.headers.get('x-frame-options'), 'DENY')
  } finally {
    await server.close()
  }
})

test('the served page can actually run under the CSP we send it with', async () => {
  // REGRESSION. The CSP said `script-src 'self'` with no 'unsafe-inline' and
  // the page's only script was inline, so the browser refused to run it and the
  // page sat at "loading /api/bootstrap…" forever.
  //
  // Two tests already existed and neither could catch it: one asserted the CSP
  // was strict, the other that the document rendered. The property that was
  // missing is the RELATIONSHIP between them — a page is only correct with
  // respect to the policy it is served under.
  const s = store(baseState())
  const server = await startWebServer({ ...deps(s), port: 0 })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const html = await (await fetch(`${base}/`)).text()

    // No <script> may carry a body; every one must reference a URL.
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      // `?? ''` rather than `!`: both groups are always present on a match, so
      // the fallback is unreachable — and a default that cannot be wrong beats
      // an assertion that could be.
      assert.equal((m[2] ?? '').trim(), '', 'an inline script cannot execute under our own CSP')
      assert.match(m[1] ?? '', /\bsrc=/, 'a script tag with no src and no body does nothing')
    }

    // …and the script it references is really served, as JavaScript.
    const script = await fetch(`${base}${FALLBACK_SCRIPT_PATH}`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
    assert.match(await script.text(), /api\/bootstrap/)
  } finally {
    await server.close()
  }
})

test('the server binds loopback only', async () => {
  const s = store(baseState())
  const server = await startWebServer({ ...deps(s), port: 0 })
  try {
    // 0.0.0.0 would expose config.json to every user on a shared machine.
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:/)
  } finally {
    await server.close()
  }
})

// provider CRUD

test('bootstrap exposes the full CLI option surface, not a hard-coded subset', () => {
  // The UI must never carry its own copy of this vocabulary — it would drift
  // from the adapter's table and offer flags that do nothing.
  const s = store(baseState())
  const body = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, deps(s))
    .body as Record<string, unknown>

  const flags = body.compatFlags as { id: string; env: string; consequence: string | null }[]
  assert.ok(flags.length >= 7, 'every compat flag should be offered')
  const costly = flags.find((f) => f.id === 'disableNonessentialTraffic')
  assert.ok(costly?.consequence, 'a flag that trades something away must say so in the UI too')
  assert.deepEqual(body.credentialEnvs, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
  assert.ok(Array.isArray(body.tiers))
  assert.ok(Array.isArray(body.reservedProviderIds))
})

test('installed agents are reported as unknown rather than faked when unavailable', () => {
  // A caller with no process port gets null, not `installed: false` — which
  // would be a claim nobody checked.
  const s = store(baseState())
  const withoutProbe = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, deps(s))
  assert.equal((withoutProbe.body as Record<string, unknown>).installedAgents, null)

  const withProbe = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, {
    ...deps(s),
    installed: () => [
      { id: 'claude-code', label: 'Claude Code', installed: true, path: '/usr/bin/claude', error: null },
      { id: 'kilo', label: 'Kilo CLI', installed: false, path: null, error: 'not found on PATH' },
    ],
  })
  const agentsFound = (withProbe.body as Record<string, unknown>).installedAgents as unknown[]
  assert.equal(agentsFound.length, 2)
})

test('the API refuses a key+session account with core\'s exact sentence', () => {
  // The rule lives in core/account.ts so this endpoint, the CLI listing, the
  // doctor and the launch path cannot drift apart on it — they already had,
  // and the doctor was calling such an account healthy.
  const refusal = parseAccount(
    { provider: 'anthropic', apiKey: 'sk-x', configDir: '/home/u/.claude' },
    undefined,
  )
  assert.equal(refusal, CONFLICT_REASON)

  // …and each mode ALONE is still accepted, or the refusal would be useless.
  assert.equal(typeof parseAccount({ provider: 'anthropic', configDir: '/d' }, undefined), 'object')
  assert.equal(typeof parseAccount({ provider: 'anthropic', apiKey: 'sk-x' }, undefined), 'object')
})

test('session logins are reported as unknown rather than faked when unwired', () => {
  // Same rule as installedAgents, and it matters more here: an empty map would
  // be indistinguishable from "every account is logged out", which would send a
  // user to re-run `/login` on accounts that are fine.
  const s = store(baseState())
  const without = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, deps(s))
  assert.equal((without.body as Record<string, unknown>).logins, null)

  const withIdentities = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, {
    ...deps(s),
    identities: () => ({ personal: 'a@b.c  ·  Max 20x', spare: null }),
  })
  assert.deepEqual((withIdentities.body as Record<string, unknown>).logins, {
    personal: 'a@b.c  ·  Max 20x',
    spare: null,
  })
})

test('a custom provider round-trips through the API and becomes launchable', () => {
  const s = store(baseState())
  const created = handleApi(
    {
      method: 'PUT',
      path: '/api/providers/my-gw',
      body: {
        revision: s.revision!(),
        provider: {
          label: 'My Gateway',
          baseUrl: 'https://gw.example.com/anthropic',
          defaultModels: { opus: 'big' },
        },
      },
    },
    deps(s),
  )
  assert.equal(created.status, 200)
  assert.equal(s.state.providers!['my-gw']!.label, 'My Gateway')

  // …and the very next bootstrap serves it merged with the shipped presets.
  const body = handleApi({ method: 'GET', path: '/api/bootstrap', body: null }, deps(s))
    .body as { providers: { id: string }[]; customProviders: Record<string, unknown> }
  assert.ok(body.providers.some((p) => p.id === 'my-gw'), 'a new provider was not merged')
  assert.ok('my-gw' in body.customProviders, 'the UI cannot tell which providers it may edit')
})

test('the API refuses an invalid provider with the validator’s own reason', () => {
  const s = store(baseState())
  const res = handleApi(
    {
      method: 'PUT',
      path: '/api/providers/bad',
      body: {
        revision: s.revision!(),
        provider: { label: 'Bad', baseUrl: 'https://gw.example.com/v1' },
      },
    },
    deps(s),
  )
  assert.equal(res.status, 400)
  assert.match(String((res.body as { error: string }).error), /v1\/v1\/messages/)
  assert.equal(s.saves, 0)
})

test('a provider may not shadow a shipped id, through the API either', () => {
  const s = store(baseState())
  const res = handleApi(
    {
      method: 'PUT',
      path: '/api/providers/openrouter',
      body: {
        revision: s.revision!(),
        provider: { label: 'Not OpenRouter', baseUrl: 'https://attacker.example' },
      },
    },
    deps(s),
  )
  assert.equal(res.status, 400)
  assert.equal(s.saves, 0)
})

test('deleting a provider reports orphaned profiles rather than silently repairing them', () => {
  // Only the user knows which provider the profile should point at now.
  const s = store(baseState())
  handleApi(
    {
      method: 'PUT',
      path: '/api/providers/my-gw',
      body: {
        revision: s.revision!(),
        provider: { label: 'GW', baseUrl: 'https://gw.example.com' },
      },
    },
    deps(s),
  )
  // A profile reaches a provider THROUGH an account now, so the chain has three
  // links: provider -> account -> profile. Deleting the provider orphans the
  // account, which in turn orphans the profile, and both are reported.
  handleApi(
    {
      method: 'PUT',
      path: '/api/accounts/gw-acct',
      body: { revision: s.revision!(), account: { provider: 'my-gw' } },
    },
    deps(s),
  )
  handleApi(
    {
      method: 'PUT',
      path: '/api/agent-profiles/gw-agent',
      body: { revision: s.revision!(), agentProfile: {} },
    },
    deps(s),
  )
  handleApi(
    {
      method: 'PUT',
      path: '/api/profiles/uses-gw',
      body: {
        revision: s.revision!(),
        profile: { agentProfile: 'gw-agent', accounts: ['gw-acct'] },
      },
    },
    deps(s),
  )
  const res = handleApi(
    { method: 'DELETE', path: '/api/providers/my-gw', body: { revision: s.revision!() } },
    deps(s),
  )
  assert.equal(res.status, 200)
  const body = res.body as { orphanedAccounts: string[]; orphanedProfiles: string[] }
  assert.deepEqual(body.orphanedAccounts, ['gw-acct'])
  assert.deepEqual(body.orphanedProfiles, ['uses-gw'])
  assert.ok(s.state.profiles['uses-gw'], 'the profile must survive; only the user can repoint it')
})

test('contextWindows accepts measured integers and drops anything else', () => {
  // It feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW; a bad value there overflows the
  // conversation instead of compacting it.
  const parsed = parseAgentProfile(
    { contextWindows: { good: 200000, zero: 0, neg: -1, str: '100', frac: 1.5 } },
    undefined,
  )
  assert.notEqual(typeof parsed, 'string')
  assert.deepEqual((parsed as { contextWindows: unknown }).contextWindows, { good: 200000 })
})

// ── the document's own CSP ──

test('the document CSP allows its inline script by HASH, not by unsafe-inline', () => {
  // The page needs exactly one inline script — the theme resolver, which must
  // run before first paint or every dark-mode user gets a white flash. Allowing
  // it with `unsafe-inline` would allow ANY injected script; a hash allows
  // those exact bytes and nothing else, so this is tighter than the alternative
  // rather than a concession.
  const html = '<html><head><script>document.documentElement.dataset.theme="dark"</script></head></html>'
  const csp = documentSecurityHeaders(html)['content-security-policy']!
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/)
  assert.doesNotMatch(csp, /unsafe-inline[^;]*script/)
  // Everything else about the policy is untouched.
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
})

test('a different script body produces a different hash — tampering breaks it', () => {
  // The property that makes this safe: the hash is computed from the document
  // actually being served, so an injected script cannot match it.
  const a = documentSecurityHeaders('<script>one()</script>')['content-security-policy']!
  const b = documentSecurityHeaders('<script>two()</script>')['content-security-policy']!
  assert.notEqual(a, b)
})

test('external scripts are governed by \'self\' and are not hashed', () => {
  // Hashing a `src` script would be meaningless — the hash applies to inline
  // bodies. The bundle is loaded this way and must stay covered by 'self'.
  assert.deepEqual(inlineScriptHashes('<script src="/app.js"></script>'), [])
  assert.deepEqual(inlineScriptHashes('<script type="module" src="/x.js"></script>'), [])
  assert.equal(inlineScriptHashes('<script>  </script>').length, 0, 'an empty script needs no hash')
})

test('a document with no inline script gets the plain strict policy', () => {
  const csp = documentSecurityHeaders('<html></html>')['content-security-policy']!
  assert.match(csp, /script-src 'self';/)
  assert.doesNotMatch(csp, /sha256/)
})
