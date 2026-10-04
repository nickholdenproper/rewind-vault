import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  "config-test.mjs",
  "first-run-test.mjs",
  "archive-test.mjs",
  "archive-failure-test.mjs",
  "keep-test.mjs",
  "plugin-test.mjs",
  "ui-test.mjs",
  "align-check.mjs",
]

for (const suite of suites) {
  process.stdout.write(`\n== ${suite} ==\n`)
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: "inherit" })
  if (result.status !== 0) {
    process.stdout.write(`${suite} failed with code ${result.status}\n`)
    process.exitCode = 1
  }
}

if (!fs.existsSync(path.join(here, "ui-test.mjs"))) process.exitCode = 1

if (!process.exitCode) process.stdout.write("\nall suites passed\n")