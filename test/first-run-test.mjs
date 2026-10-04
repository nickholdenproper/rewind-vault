import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const realWrite = process.stdout.write.bind(process.stdout)
let full = ""
let pending = ""
const capture = (text) => {
  full += text
  pending += text
  return true
}
const fakeStdout = { isTTY: true, columns: 100, rows: 40, write: capture }
Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true })

const stdin = new EventEmitter()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.resume = () => stdin
stdin.pause = () => stdin
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })

const root = path.join(os.tmpdir(), `rewind-firstrun-${process.pid}-${Date.now()}`)
const home = path.join(root, "home")
process.env.REWIND_HOME = home
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
delete process.env.REWIND_VAULT
process.env.OC_PLAIN = "1"
process.env.OC_WIDTH = "100"
process.env.OC_ROWS = "40"
process.env.OC_DRY_RUN = "1"
// Archiving is folder-agnostic now, so this test would otherwise read the real
// session database and spend its timeout exporting the user's own sessions.
process.env.OPENCODE_BIN = new URL("./fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
process.env.FAKE_OPENCODE_ROWS = "[]"
await fsp.mkdir(home, { recursive: true })

const launcher = await import("../launcher.mjs")
const config = await import("../lib/config.mjs")

const ENTER = "\r"
const ESC = "\u001b"
const BACKSPACE = "\u007f"
const plain = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
const delay = (ms = 45) => new Promise((resolve) => setTimeout(resolve, ms))

async function keys(items, settle = 45) {
  for (const key of items) {
    stdin.emit("data", Buffer.from(key, "utf8"))
    await delay(settle)
  }
}

async function until(text, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!pending.includes(text)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}\n--- pending ---\n${plain(pending).slice(-1500)}`)
    await delay(30)
  }
  pending = ""
}

const run = (args) => {
  const original = process.argv
  process.argv = ["node", "rewind", ...args]
  const done = launcher.main().finally(() => {
    process.argv = original
  })
  return done
}

let passed = 0
let failed = 0
const check = async (name, fn) => {
  full = ""
  pending = ""
  try {
    await fn()
    passed++
    realWrite(`  ok  ${name}\n`)
  } catch (error) {
    failed++
    realWrite(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

const configFile = () => path.join(process.env.REWIND_CONFIG_DIR, "config.json")
const retype = (text, prefill) => [...Array.from({ length: prefill.length }, () => BACKSPACE), ...text]

await check("the first run asks where the vault should live", async () => {
  const running = run([])
  await until("Where should rewind keep your saved sessions?")
  await keys([ENTER])
  await until("Load a session")
  await keys([ESC])
  await running
})

await check("pressing enter keeps the suggested folder", async () => {
  const state = config.describe(await config.readConfig())
  assert.equal(state.configured, true)
  assert.equal(state.vault, path.join(home, ".rewind"))
  assert.equal(state.exists, true)
  assert.ok(fs.statSync(path.join(state.vault, "sessions")).isDirectory())
  assert.ok(fs.statSync(path.join(state.vault, "db")).isDirectory())
})

await check("the answer is written to config.json, not just remembered", async () => {
  const raw = JSON.parse(await fsp.readFile(configFile(), "utf8"))
  assert.equal(raw.version, 1)
  assert.equal(raw.vault, path.join(home, ".rewind"))
})

await check("the second run goes straight to the menu", async () => {
  const running = run([])
  await until("Clear all history")
  assert.equal(plain(full).includes("Where should rewind keep"), false)
  await keys([ESC])
  await running
})

await check("rewind setup <folder> moves the vault and creates it", async () => {
  const typed = path.join(root, "typed vault")
  await fsp.mkdir(root, { recursive: true })
  const running = run(["setup", typed])
  await until("Where should rewind keep your saved sessions?")
  await keys([ENTER])
  await until("Done.")
  await keys([ENTER])
  assert.equal(await running, 0)
  assert.equal(config.describe(await config.readConfig()).vault, typed)
  assert.ok(fs.statSync(path.join(typed, "sessions")).isDirectory())
  assert.ok(fs.statSync(path.join(typed, "db")).isDirectory())
})

await check("a bad path is refused in the dialog, not after it", async () => {
  const blocked = path.join(root, "blocked")
  await fsp.mkdir(blocked, { recursive: true })
  await fsp.writeFile(path.join(blocked, "child"), "not a folder")
  const running = run(["setup", path.join(blocked, "child", "vault")])
  await until("Where should rewind keep your saved sessions?")
  await keys([ENTER])
  await until("parent folder is not a folder")
  assert.equal(config.describe(await config.readConfig()).vault, path.join(root, "typed vault"))
  await keys([ESC])
  assert.equal(await running, 130)
})

await check("~ and %VAR% are expanded before the folder is created", async () => {
  await fsp.rm(configFile(), { force: true })
  const prefill = config.defaultVault()
  const running = run(["setup"])
  await until("Where should rewind keep your saved sessions?")
  await keys(retype("%REWIND_HOME%/expanded-vault", prefill), 18)
  await keys([ENTER])
  await until("Done.")
  await keys([ENTER])
  assert.equal(await running, 0)
  assert.equal(config.describe(await config.readConfig()).vault, path.join(home, "expanded-vault"))
  assert.ok(fs.statSync(path.join(home, "expanded-vault", "sessions")).isDirectory())
})

await check("esc on the location prompt leaves the config untouched", async () => {
  const before = await fsp.readFile(configFile(), "utf8")
  await fsp.rm(configFile())
  const running = run([])
  await until("Where should rewind keep your saved sessions?")
  await keys([ESC])
  await running
  assert.equal(fs.existsSync(configFile()), false)
  assert.match(plain(full), /dry-run/)
  await fsp.writeFile(configFile(), before)
})

await check("non-interactive runs never prompt and fall back to ~/.rewind", async () => {
  await fsp.rm(process.env.REWIND_CONFIG_DIR, { recursive: true, force: true })
  const savedStdout = process.stdout
  Object.defineProperty(process, "stdout", { value: { isTTY: false, write: capture }, configurable: true })
  try {
    const running = run(["history", "list"])
    assert.equal(await running, 0)
    assert.equal(plain(full).includes("Where should rewind keep"), false)
  } finally {
    Object.defineProperty(process, "stdout", { value: savedStdout, configurable: true })
  }
  assert.equal(config.describe(await config.readConfig()).vault, path.join(home, ".rewind"))
  assert.ok(fs.statSync(path.join(home, ".rewind", "sessions")).isDirectory())
})

await check("REWIND_VAULT overrides the stored location", async () => {
  const other = path.join(root, "env-vault")
  process.env.REWIND_VAULT = other
  await fsp.mkdir(other, { recursive: true })
  try {
    assert.equal(await run(["history", "list"]), 0)
    const store = await import("../lib/store.mjs")
    assert.equal(store.VAULT, other)
  } finally {
    delete process.env.REWIND_VAULT
  }
})

await check("rewind where and rewind doctor report the resolved paths", async () => {
  const configured = config.describe(await config.readConfig()).vault
  assert.equal(await run(["where"]), 0)
  const afterWhere = plain(full)
  assert.ok(afterWhere.includes("vault"))
  assert.ok(afterWhere.includes(configured), `where should mention ${configured}`)
  await run(["doctor"])
  const frame = plain(full)
  assert.ok(frame.includes("opencode"))
  assert.ok(frame.includes("node"))
})

await fsp.rm(root, { recursive: true, force: true })

realWrite(`\n${passed + failed} first-run checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0