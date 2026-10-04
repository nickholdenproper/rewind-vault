import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.join(os.tmpdir(), `rewind-config-test-${process.pid}-${Date.now()}`)
process.env.REWIND_HOME = path.join(root, "home")
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
delete process.env.REWIND_VAULT
await fsp.mkdir(process.env.REWIND_HOME, { recursive: true })

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

await check("expandPath understands ~, %VAR% and $VAR", () => {
  assert.equal(config.expandPath("~"), path.resolve(process.env.REWIND_HOME))
  assert.equal(config.expandPath("~/vault"), path.join(path.resolve(process.env.REWIND_HOME), "vault"))
  assert.equal(config.expandPath("  '~/quoted'  "), path.join(path.resolve(process.env.REWIND_HOME), "quoted"))
  assert.equal(config.expandPath("%REWIND_HOME%/x"), path.join(path.resolve(process.env.REWIND_HOME), "x"))
  assert.equal(config.expandPath("$REWIND_HOME/x"), path.join(path.resolve(process.env.REWIND_HOME), "x"))
  assert.equal(config.expandPath("${REWIND_HOME}/x"), path.join(path.resolve(process.env.REWIND_HOME), "x"))
  assert.equal(config.expandPath("   "), "")
  assert.ok(path.isAbsolute(config.expandPath("relative/place")))
})

await check("defaultVault is ~/.rewind unless REWIND_VAULT is set", () => {
  assert.equal(config.defaultVault(), path.join(path.resolve(process.env.REWIND_HOME), ".rewind"))
  process.env.REWIND_VAULT = "$REWIND_HOME/custom-vault"
  assert.equal(config.defaultVault(), path.join(path.resolve(process.env.REWIND_HOME), "custom-vault"))
  delete process.env.REWIND_VAULT
})

await check("config lives under REWIND_CONFIG_DIR", async () => {
  const state = config.describe({})
  assert.equal(state.configDir, path.resolve(process.env.REWIND_CONFIG_DIR))
  assert.equal(state.configPath, path.join(path.resolve(process.env.REWIND_CONFIG_DIR), "config.json"))
  assert.equal(state.configured, false)
  assert.equal(fs.existsSync(state.configPath), false)
})

await check("vaultProblem rejects unusable locations", async () => {
  const home = path.resolve(process.env.REWIND_HOME)
  assert.match(config.vaultProblem(""), /required/)
  assert.match(config.vaultProblem(home), /home directory itself/)
  assert.match(config.vaultProblem(path.parse(home).root), /drive root/)
  assert.match(config.vaultProblem(path.join(home, "sessions")), /vault folder itself/)
  assert.equal(config.vaultProblem(path.join(home, "nope", "deeper")), undefined)
  const file = path.join(home, "a-file")
  await fsp.writeFile(file, "x")
  assert.match(config.vaultProblem(file), /file, not a folder/)
  assert.match(config.vaultProblem("%REWIND_NOT_SET%/vault"), /is not set on this machine/)
  assert.match(config.vaultProblem("$REWIND_NOT_SET/vault"), /is not set on this machine/)
  assert.equal(config.vaultProblem(path.join(home, "vault")), undefined)
  assert.equal(config.vaultProblem("$REWIND_HOME/vault"), undefined)
})

await check("prepareVault creates the layout and proves it is writable", async () => {
  const target = path.join(path.resolve(process.env.REWIND_HOME), "vault")
  const resolved = await config.prepareVault(target)
  assert.equal(resolved, target)
  assert.ok(fs.statSync(path.join(target, "sessions")).isDirectory())
  assert.ok(fs.statSync(path.join(target, "db")).isDirectory())
  assert.equal(fs.readdirSync(target).includes(".rewind-write-test"), false)
  assert.equal(await config.prepareVault(target), target)
  await assert.rejects(() => config.prepareVault(path.join(target, "sessions")), /vault folder itself/)
})

await check("writeConfig and readConfig round trip", async () => {
  const target = path.join(path.resolve(process.env.REWIND_HOME), "vault")
  await config.writeConfig({ vault: target, extra: "kept" })
  const loaded = await config.readConfig()
  assert.equal(loaded.version, 1)
  assert.equal(loaded.vault, target)
  assert.equal(loaded.extra, "kept")
  assert.equal(config.configuredVault(loaded), target)
  assert.equal(config.describe(loaded).configured, true)
  assert.equal(config.describe(loaded).exists, true)
})

await check("a bad parent is reported in plain language, not a raw errno", async () => {
  const blocker = path.join(path.resolve(process.env.REWIND_HOME), "blocked")
  await fsp.mkdir(blocker, { recursive: true })
  await fsp.writeFile(path.join(blocker, "child"), "not a folder")
  await assert.rejects(() => config.prepareVault(path.join(blocker, "child", "vault")), /parent folder is not a folder/)
})

await check("a folder that does not exist yet is created", async () => {
  const deep = path.join(path.resolve(process.env.REWIND_HOME), "new", "nested", "vault")
  assert.equal(config.vaultProblem(deep), undefined)
  assert.equal(await config.prepareVault(deep), deep)
  assert.ok(fs.statSync(path.join(deep, "sessions")).isDirectory())
  assert.ok(fs.statSync(path.join(deep, "db")).isDirectory())
})

await check("REWIND_VAULT beats the stored location", async () => {
  const target = path.join(path.resolve(process.env.REWIND_HOME), "vault")
  await config.writeConfig({ vault: target })
  assert.equal(config.configuredVault({ vault: target }), target)
  process.env.REWIND_VAULT = "$REWIND_HOME/env-vault"
  assert.equal(config.configuredVault({ vault: target }), path.join(path.resolve(process.env.REWIND_HOME), "env-vault"))
  assert.equal(config.defaultVault(), path.join(path.resolve(process.env.REWIND_HOME), "env-vault"))
  delete process.env.REWIND_VAULT
})

await check("store.setVault repoints every derived path", async () => {
  const target = path.join(path.resolve(process.env.REWIND_HOME), "vault")
  assert.equal(store.setVault(target), target)
  assert.equal(store.VAULT, target)
  assert.equal(store.SESSIONS_DIR, path.join(target, "sessions"))
  assert.equal(store.DB_DIR, path.join(target, "db"))
  assert.equal(store.INDEX_PATH, path.join(target, "index.json"))
  assert.equal((await store.readIndex()).sessions.length, 0)
  assert.ok(path.isAbsolute(store.VAULT))
  assert.notEqual(store.VAULT, "D:\\OpenCode_History")
})

await check("no source file hardcodes the old vault path", async () => {
  const files = ["../lib/config.mjs", "../lib/store.mjs", "../lib/ui.mjs", "../lib/theme.mjs", "../launcher.mjs", "../bin/rewind.mjs"]
  for (const file of files) {
    const text = await fsp.readFile(new URL(file, import.meta.url), "utf8")
    assert.equal(/OpenCode_History|morbi/i.test(text), false, `${file} still mentions the old machine`)
  }
})

await fsp.rm(root, { recursive: true, force: true })

process.stdout.write(`\n${passed + failed} config checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0