import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Its own process on purpose: opencodeBin() memoises the first binary it
// resolves, so the only way to point it at a dud is to do so before anything
// else asks for one.
const root = path.join(os.tmpdir(), `rewind-archive-failure-${process.pid}-${Date.now()}`)
process.env.REWIND_HOME = path.join(root, "home")
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
delete process.env.REWIND_VAULT
delete process.env.FAKE_OPENCODE_ROWS
await fsp.mkdir(process.env.REWIND_HOME, { recursive: true })

const dud = path.join(root, "not-really-opencode.mjs")
await fsp.writeFile(dud, "throw new Error('this stand-in cannot answer db queries')\n")
process.env.OPENCODE_BIN = dud

const config = await import("../lib/config.mjs")
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

await check("opencodeBin honours OPENCODE_BIN", () => {
  assert.equal(store.opencodeBin(), dud)
})

await check("a broken opencode surfaces as an error from dbQuery", async () => {
  await assert.rejects(() => store.dbQuery("SELECT 1"), /failed/)
})

await check("autoArchive throws when the database cannot be read", async () => {
  const vault = path.join(root, "vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  await store.upsertProject({ name: "Broken", folder: path.join(root, "code", "app") })
  await assert.rejects(() => store.autoArchive(), /failed/)
})

await check("archiveNewSessions reports the failure instead of swallowing it", async () => {
  const result = await store.archiveNewSessions()
  assert.ok(result.error, "a failed database read has to be reported")
  assert.deepEqual(result.saved, [])
  assert.deepEqual(result.missing, [])
  assert.match(String(result.error.message), /failed/)
})

await fsp.rm(root, { recursive: true, force: true })

process.stdout.write(`\n${passed + failed} archive-failure checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0
