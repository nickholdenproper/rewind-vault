#!/usr/bin/env node
import { main } from "../launcher.mjs"

main().then(
  (code) => {
    process.exitCode = typeof code === "number" ? code : 0
  },
  (error) => {
    const aborted = error?.message === "aborted"
    if (!aborted) process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = aborted ? 130 : 1
  },
)