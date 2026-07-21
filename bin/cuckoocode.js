#!/usr/bin/env node
// Deliberately plain JavaScript, deliberately outside src/, deliberately never
// compiled. It is the one file that has to run before anything is known about
// the environment, so it carries no dependencies and no syntax that needs a
// build step. Everything it points at IS built: dist/ is compiled output, so
// the published package never relies on Node's native type stripping.
import { runCli } from '../dist/cli.js'

runCli(process.argv.slice(2)).catch((err) => {
  console.error(`cuckoocode: ${err.message}`)
  process.exit(1)
})
