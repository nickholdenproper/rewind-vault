import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.join(os.tmpdir(), `rewind-version-test-${process.pid}-${Date.now()}`)
process.env.REWIND_HOME = path.join(root, "home")
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
delete process.env.REWIND_VAULT
await fsp.mkdir(process.env.REWIND_HOME, { recursive: true })

const store = await import("../lib/store.mjs")

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed++
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failed++
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

await check("the floor is opencode 1.2.4, where db first shipped", () => {
  assert.equal(store.MIN_OPENCODE, "1.2.4")
})

await check("parseVersion splits a stable release", () => {
  assert.deepEqual(store.parseVersion("1.2.4"), { parts: [1, 2, 4], stable: true })
  assert.deepEqual(store.parseVersion("  1.18.34  "), { parts: [1, 18, 34], stable: true })
})

await check("parseVersion marks prereleases unstable", () => {
  assert.deepEqual(store.parseVersion("0.0.0-dev-202602150035"), { parts: [0, 0, 0], stable: false })
  assert.deepEqual(store.parseVersion("1.2.5-rc1"), { parts: [1, 2, 5], stable: false })
})

await check("parseVersion gives up rather than guessing", () => {
  assert.equal(store.parseVersion("installed"), undefined)
  assert.equal(store.parseVersion(""), undefined)
  assert.equal(store.parseVersion(undefined), undefined)
  assert.equal(store.parseVersion(null), undefined)
})

await check("anything below the floor is too old", () => {
  assert.equal(store.opencodeTooOld("1.2.3"), true)
  assert.equal(store.opencodeTooOld("1.1.65"), true)
  assert.equal(store.opencodeTooOld("0.9.0"), true)
  assert.equal(store.opencodeTooOld("1.1.100"), true)
})

await check("the floor itself and anything above it are fine", () => {
  assert.equal(store.opencodeTooOld("1.2.4"), false)
  assert.equal(store.opencodeTooOld("1.18.34"), false)
  assert.equal(store.opencodeTooOld("2.0.0"), false)
  assert.equal(store.opencodeTooOld("10.0.0"), false)
  // minor 10 is above minor 2 — the same trap as 1.2.10, one component along
  assert.equal(store.opencodeTooOld("1.10.0"), false)
})

await check("double-digit components compare numerically, not as text", () => {
  // "1.2.10" < "1.2.4" and "1.10.0" < "1.2.4" are both true as strings, which
  // would nag every install from that point on.
  assert.equal(store.opencodeTooOld("1.2.10"), false)
  assert.equal(store.opencodeTooOld("1.2.100"), false)
})

await check("prereleases and unreadable versions are never nagged", () => {
  assert.equal(store.opencodeTooOld("0.0.0-fake"), false)
  assert.equal(store.opencodeTooOld("0.0.0-dev-202602150035"), false)
  assert.equal(store.opencodeTooOld("installed"), false)
  assert.equal(store.opencodeTooOld(undefined), false)
})

await check("a two-part version is unparseable, so not flagged", () => {
  assert.equal(store.parseVersion("1.2"), undefined)
  assert.equal(store.opencodeTooOld("1.2"), false)
})

// opencodeBin() memoises, so one stub serves both cases and branches on argv:
// store.mjs runs a .mjs OPENCODE_BIN through node, which is how it stands in
// for an opencode too old to know the subcommand.
const stub = path.join(root, "stub-opencode.mjs")
await fsp.writeFile(
  stub,
  'process.stderr.write(process.argv.includes("export") ? "disk on fire\\n" : "unknown command: db\\n")\nprocess.exit(1)\n',
)
process.env.OPENCODE_BIN = stub

await check("a missing subcommand points the user at doctor", async () => {
  await assert.rejects(() => store.capture(["db", "path"]), (error) => {
    assert.match(error.message, /unknown command/)
    assert.match(error.message, /rewind doctor/)
    return true
  })
})

await check("an unrelated failure is not dressed up as a version problem", async () => {
  await assert.rejects(() => store.capture(["export", "ses_x"]), (error) => {
    assert.match(error.message, /disk on fire/)
    assert.doesNotMatch(error.message, /rewind doctor/)
    return true
  })
})

delete process.env.OPENCODE_BIN

await fsp.rm(root, { recursive: true, force: true })

process.stdout.write(`\n${passed + failed} version checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0
