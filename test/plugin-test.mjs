import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.join(os.tmpdir(), `rewind-plugin-test-${process.pid}-${Date.now()}`)
const home = path.join(root, "home")
process.env.REWIND_HOME = home
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
// Keep the plugin installer away from the real ~/.config/opencode.
process.env.XDG_CONFIG_HOME = path.join(root, "xdg")
delete process.env.REWIND_VAULT
await fsp.mkdir(home, { recursive: true })

const config = await import("../lib/config.mjs")
const plugin = await import("../lib/plugin.mjs")
const store = await import("../lib/store.mjs")

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
const FAKE = path.join(REPO, "test", "fixtures", "fake-opencode.mjs")
const foreign = (value) => value.split(path.sep).join("/")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stands in for Bun's `$`. It is a tagged template, so the interpolated values
 * arrive as separate arguments and have to be stitched back together -- ignoring
 * them would make every assertion below pass on an empty command.
 */
function stubShell(calls, { fail = false } = {}) {
  return (strings, ...values) => {
    const text = [strings[0], ...values.map((value, i) => `${value}${strings[i + 1] ?? ""}`)].join("")
    if (fail) throw new Error("bun shell unavailable")
    return { quiet: () => ({ nothrow: async () => void calls.push(text) }) }
  }
}

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

async function makeFolder(dir = "code/live") {
  const made = path.join(root, dir)
  await fsp.mkdir(made, { recursive: true })
  return made
}

await check("the plugin dir is opencode's, not rewind's", () => {
  assert.equal(plugin.opencodePluginDir(), path.join(root, "xdg", "opencode", "plugins"))
  assert.notEqual(plugin.opencodePluginDir(), config.configDir())
  assert.equal(plugin.pluginPath(), path.join(root, "xdg", "opencode", "plugins", "rewind-live.js"))
})

await check("rendering bakes in node and the worker, and leaves no placeholders", () => {
  const body = plugin.renderPlugin({ node: "C:/node.exe", worker: "C:/rewind/archive-once.mjs" })
  assert.ok(!body.includes("__REWIND_"), "no placeholder should survive")
  assert.match(body, /const NODE = "C:\/node\.exe"/)
  assert.match(body, /const WORKER = "C:\/rewind\/archive-once\.mjs"/)
})

await check("the rendered plugin is valid javascript", async () => {
  const dir = path.join(root, "syntax")
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, "rewind-live.js")
  await fsp.writeFile(file, plugin.renderPlugin({ node: process.execPath, worker: plugin.workerPath() }))
  await assert.doesNotReject(import(`${new URL(`file:///${file.replace(/\\/g, "/")}`).href}?v=${Date.now()}`))
})

await check("status reports nothing before install", async () => {
  const status = await plugin.pluginStatus()
  assert.equal(status.installed, false)
  assert.equal(status.current, false)
})

await check("install writes the plugin where opencode will find it", async () => {
  const done = await plugin.installPlugin()
  assert.ok(fs.existsSync(done.file))
  assert.ok(fs.existsSync(plugin.opencodePluginDir()), "the plugins dir should be created if missing")

  const status = await plugin.pluginStatus()
  assert.equal(status.installed, true)
  assert.equal(status.current, true)
  assert.equal(status.worker, plugin.workerPath())
  assert.equal(status.node, process.execPath)
})

await check("install is idempotent", async () => {
  const first = fs.readFileSync(plugin.pluginPath(), "utf8")
  await plugin.installPlugin()
  assert.equal(fs.readFileSync(plugin.pluginPath(), "utf8"), first)
})

await check("a plugin pointing at a moved rewind reads as stale", async () => {
  const status = await plugin.pluginStatus()
  const original = plugin.workerPath
  assert.ok(status.current)
  // Simulate an upgrade that relocated the worker without reinstalling.
  const body = fs.readFileSync(plugin.pluginPath(), "utf8").replace(/"[^"]*archive-once\.mjs"/, '"D:/gone/archive-once.mjs"')
  await fsp.writeFile(plugin.pluginPath(), body)
  assert.equal((await plugin.pluginStatus()).current, false)
  await plugin.installPlugin()
  assert.equal((await plugin.pluginStatus()).current, true, "reinstalling should clear staleness")
  assert.ok(original)
})

await check("uninstall removes it", async () => {
  const done = await plugin.uninstallPlugin()
  assert.equal(done.removed, true)
  assert.equal(fs.existsSync(plugin.pluginPath()), false)
  assert.equal((await plugin.pluginStatus()).installed, false)
  assert.equal((await plugin.uninstallPlugin()).removed, false, "uninstalling twice is harmless")
})

await check("the plugin only reacts to session.idle", async () => {
  const calls = []
  const hooks = await makePlugin(stubShell(calls))
  for (const type of ["message.part.updated", "session.updated", "file.edited", "session.created"]) {
    await hooks.event({ event: { type, properties: { sessionID: "ses_x" } } })
  }
  assert.deepEqual(calls, [], "only session.idle should trigger a save")
})

await check("session.idle shells out to the worker with the session id", async () => {
  const calls = []
  const hooks = await makePlugin(stubShell(calls))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_abc123" } } })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes("ses_abc123"), `expected the session id in ${JSON.stringify(calls[0])}`)
  assert.ok(calls[0].includes("archive-once.mjs"), `expected the worker in ${JSON.stringify(calls[0])}`)
})

await check("rapid repeats for one session collapse into a single save", async () => {
  const calls = []
  const hooks = await makePlugin(stubShell(calls))
  const idle = { event: { type: "session.idle", properties: { sessionID: "ses_burst" } } }
  await hooks.event(idle)
  await hooks.event(idle)
  await hooks.event(idle)
  assert.equal(calls.length, 1, "subagent chatter should not spawn three processes")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_other" } } })
  assert.equal(calls.length, 2, "a different session is a different turn")
})

await check("a broken shell never escapes the hook", async () => {
  const hooks = await makePlugin(stubShell([], { fail: true }))
  await assert.doesNotReject(hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } }))
})

await check("a rejecting worker never escapes the hook", async () => {
  const $ = () => ({ quiet: () => ({ nothrow: async () => { throw new Error("exit 1") } }) })
  const hooks = await makePlugin($)
  await assert.doesNotReject(hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } }))
})

await check("malformed events never escape the hook", async () => {
  const hooks = await makePlugin(() => ({ quiet: () => ({ nothrow: async () => {} }) }))
  for (const event of [undefined, null, {}, { type: "session.idle" }, { type: "session.idle", properties: {} }]) {
    await assert.doesNotReject(hooks.event({ event }))
  }
})

await check("archiveSessionById archives a session from a registered project", async () => {
  const vault = path.join(root, "byid-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = await makeFolder("code/byid")

  process.env.OPENCODE_BIN = FAKE
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_byid001", title: "Idle turn", directory: foreign(folder), messages: 6, timeUpdated: 1_000 },
  ])

  const entry = await store.archiveSessionById("ses_byid001", { refresh: 0 })
  assert.ok(entry, "a registered project folder should archive")
  assert.equal(entry.sessionID, "ses_byid001")
  assert.equal(entry.messages, 6)
  assert.equal(entry.project, undefined, "nothing is filed under a project any more")
  assert.ok(fs.existsSync(store.entryFile(entry)), `archive missing at ${store.entryFile(entry)}`)
  assert.equal(entry.label, "idle-turn-d001", "the label comes from the title plus the id suffix")
})

await check("archiveSessionById archives a session from a folder it has never seen", async () => {
  // The old rule was "only if its folder is a registered project". Nothing is
  // registered any more, because nothing needs to be: a session is kept because
  // it happened, not because of where.
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_else001", title: "Elsewhere", directory: foreign(path.join(root, "not-a-project")), messages: 3, timeUpdated: 1_000 },
  ])
  const entry = await store.archiveSessionById("ses_else001", { refresh: 0 })
  assert.ok(entry, "a folder nobody registered still archives")
  assert.equal(entry.sessionID, "ses_else001")
})

await check("archiveSessionById survives an unknown or empty id", async () => {
  assert.equal(await store.archiveSessionById("", { refresh: 0 }), null)
  assert.equal(await store.archiveSessionById(null, { refresh: 0 }), null)
  assert.equal(await store.archiveSessionById("ses_nope000", { refresh: 0 }), null)
})

await check("archiveSessionById archives a session with no directory", async () => {
  // opencode does not always record a directory. Requiring one is what used to
  // lose these sessions for good.
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([{ id: "ses_nodir01", title: "No folder", directory: "", messages: 1 }])
  const entry = await store.archiveSessionById("ses_nodir01", { refresh: 0 })
  assert.ok(entry, "a session with no folder still archives")
  assert.equal(entry.directory, "")
})

await check("archiveSessionById rewrites a live session instead of freezing it", async () => {
  const rows = [{ id: "ses_idle001", title: "Steady", directory: foreign(path.join(root, "code", "byid")), messages: 4, timeUpdated: 1_000 }]
  const publish = () => { process.env.FAKE_OPENCODE_ROWS = JSON.stringify(rows) }
  publish()

  assert.ok(await store.archiveSessionById("ses_idle001", { refresh: 0 }), "first save happens")
  assert.equal(await store.archiveSessionById("ses_idle001", { refresh: 0 }), null, "an unchanged session is left alone")

  rows[0].timeUpdated = Date.now() + 1_000
  rows[0].messages = 40
  publish()
  const entry = await store.archiveSessionById("ses_idle001", { refresh: 0 })
  assert.ok(entry, "a session that moved on should be rewritten")
  assert.equal(entry.messages, 40)

  const copies = fs
    .readdirSync(path.join(root, "byid-vault", "sessions"))
    .filter((name) => name.includes("ses_idle001"))
  assert.equal(copies.length, 1, `a rewrite must overwrite, not accumulate: ${copies.join(", ")}`)
  assert.equal(
    await store.archiveSessionById("ses_idle001", { refresh: 300_000 }),
    null,
    "inside the refresh window a fresh archive is left alone",
  )
})

await check("archiveSessionById returns nothing for a session opencode has not recorded", async () => {
  const vault = path.join(root, "unknown-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  process.env.FAKE_OPENCODE_ROWS = "[]"
  assert.equal(await store.archiveSessionById("ses_byid001", { refresh: 0 }), null)
})

await check("the worker archives from argv and stays silent", async () => {
  const vault = path.join(root, "worker-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "worker")
  await fsp.mkdir(folder, { recursive: true })

  await config.writeConfig({ vault })
  store.setVault(vault)

  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_work001", title: "From the worker", directory: foreign(folder), messages: 2, timeUpdated: 1_000 },
  ])

  const good = await run(["ses_work001"])
  assert.equal(good.code, 0)
  assert.equal(good.stdout, "", "the worker must not print while opencode owns the terminal")
  assert.equal(good.stderr, "")
  const [archived] = (await store.readIndex()).sessions
  assert.equal(archived.sessionID, "ses_work001")
  assert.ok(fs.existsSync(store.entryFile(archived)), `archive missing at ${store.entryFile(archived)}`)

  const missing = await run([])
  assert.equal(missing.code, 2, "no id is a usage error")
  const unknown = await run(["ses_nothere1"])
  assert.equal(unknown.code, 0, "an unknown session is not an error")
  assert.equal(unknown.stdout, "")
})

await check("the worker saves every turn, not just every five minutes", async () => {
  const vault = path.join(root, "turn-vault")
  await fsp.rm(vault, { recursive: true, force: true })
  await config.writeConfig({ vault })
  store.setVault(vault)
  await config.prepareVault(vault)


  const rows = [{ id: "ses_turn001", title: "Every turn", directory: foreign(path.join(root, "code", "worker")), messages: 5, timeUpdated: 1_000 }]
  const publish = () => { process.env.FAKE_OPENCODE_ROWS = JSON.stringify(rows) }
  publish()

  // The five minute window belongs to the timer, which polls blind. An idle
  // event says the session changed, so the worker must not defer the save.
  process.env.REWIND_LIVE_REFRESH = "300000"
  assert.equal((await run(["ses_turn001"])).code, 0)
  assert.equal((await store.readIndex()).sessions[0].messages, 5)

  rows[0].timeUpdated = Date.now()
  rows[0].messages = 31
  publish()
  assert.equal((await run(["ses_turn001"])).code, 0)
  const saved = (await store.readIndex()).sessions[0]
  assert.equal(saved.messages, 31, "a turn two minutes later still gets saved")

  await run(["ses_turn001"])
  assert.equal((await store.readIndex()).sessions[0].savedAt, saved.savedAt, "an unchanged session is still a no-op")
})

await fsp.rm(root, { recursive: true, force: true })

process.stdout.write(`\n${passed + failed} plugin checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0

/**
 * Runs the worker the way the plugin does: a detached Node process that has to
 * report failure on stderr and say nothing on stdout.
 */
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [plugin.workerPath(), ...args], { env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

/**
 * Loads the rendered plugin the way opencode does -- as a module exporting a
 * plugin function -- and returns its hooks with a stub shell.
 */
async function makePlugin($, { node = "/fake/node", worker = "/fake/archive-once.mjs" } = {}) {
  const body = plugin.renderPlugin({ node, worker })
  const file = path.join(root, `plug-${Math.random().toString(36).slice(2)}.mjs`)
  await fsp.writeFile(file, body)
  const mod = await import(`${new URL(`file:///${file.replace(/\\/g, "/")}`).href}?v=${Date.now()}`)
  const fn = mod.RewindLivePlugin
  assert.equal(typeof fn, "function", "the plugin should export a plugin function")
  return fn({ $ })
}