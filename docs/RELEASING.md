# Releasing

Publishing is automated via [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
using npm **trusted publishing** (OIDC). No npm token is stored anywhere — not
in your shell, not in repo secrets. The workflow proves its identity to npm
directly, and every release carries a signed build-provenance attestation.

## One-time setup (npmjs.com)

Configure the trusted publisher once, on the package page:

1. npmjs.com → **swisscode** → **Settings** → **Trusted Publisher**.
2. Add a **GitHub Actions** publisher:
   - Organization / user: `jellologic`
   - Repository: `swisscode`
   - Workflow filename: `publish.yml`
3. Save. From now on npm accepts publishes from that workflow with no token.

(The package already exists, so this links the existing package to the workflow.
There is nothing to configure in GitHub — `id-token: write` is declared in the
workflow itself.)

## Cutting a release

```sh
npm version patch      # or minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags # pushes the commit AND the tag
```

Pushing the `v*` tag triggers the workflow, which:

1. installs dependencies (`npm ci`),
2. runs the full suite (`npm test`) — a red tree never publishes,
3. checks the tag matches `package.json`,
4. `npm publish --provenance`.

Watch it under the repo's **Actions** tab. To roll back a bad release, deprecate
rather than unpublish (npm holds unpublished names):

```sh
npm deprecate swisscode@X.Y.Z "use X.Y.Z+1 instead"
```

## Why not a stored token

`0.1.0` was published by hand, which meant juggling several long-lived tokens in
one session — each one a credential that then had to be revoked (see issue #13).
Trusted publishing removes the credential from the loop entirely.
