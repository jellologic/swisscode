# Tier B: swisscode against the three REAL coding CLIs.
#
# The hermetic e2e suite (test/e2e/*.e2e.ts) proves swisscode BUILDS the right
# launch against a recorder. It cannot prove the launch still works after an
# upstream release — a renamed flag, a rejected env var, a binary that moved.
# This image installs the actual CLIs and runs `test:e2e:real`, which forwards
# only `--version` (non-billable: no key, no inference, no cost) and checks that
# swisscode resolves each one and hands off cleanly.
#
# Manual-dispatch only (see .github/workflows/e2e-real.yml). Building on every
# PR would couple the merge gate to three third-party packages' availability.
#
# Build and run from the repo root:
#   docker build -f test/e2e/Dockerfile -t swisscode-e2e .
#   docker run --rm swisscode-e2e

FROM node:22-slim

WORKDIR /app

# Install swisscode's own dependencies first, in their own layer, so a source
# edit does not re-run `npm ci`. `web` is a workspace, so its manifest has to be
# present before the install resolves.
#
# `--ignore-scripts` is REQUIRED here, not an optimisation: the repo's `prepare`
# lifecycle is `node build.js`, and at this layer the source it needs has not
# been copied yet. Skipping lifecycle scripts is safe — swisscode has no native
# dependencies, and esbuild/vite ship their platform binaries via
# optionalDependencies, which npm resolves without a script. The real build runs
# explicitly below, once the source is present.
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci --ignore-scripts

# The rest of the source, then the full build — dist/cli.js is what bin/swisscode.js
# runs, and the e2e harness refuses to start without it.
COPY . .
RUN node build.js

# THE POINT OF THIS IMAGE: the three real CLIs, at PINNED versions. Pinning makes
# an upstream break a deliberate, reviewable bump in this file rather than a
# nightly mystery — the same discipline the repo already applies to its GitHub
# Actions (SHA-pinned) and its own lockfile. Bump these when verifying against a
# newer release on purpose.
RUN npm install -g \
      @anthropic-ai/claude-code@2.1.218 \
      @kilocode/cli@7.4.15 \
      opencode-ai@1.18.4

# Prove they are all resolvable before the suite runs, so a failed global install
# is a clear build-time error rather than a confusing skip at test time.
RUN claude --version && kilo --version && opencode --version

CMD ["npm", "run", "test:e2e:real"]
