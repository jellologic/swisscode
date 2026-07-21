#!/usr/bin/env node
import { runCli } from '../src/cli.js'

runCli(process.argv.slice(2)).catch((err) => {
  console.error(`cuckoocode: ${err.message}`)
  process.exit(1)
})
