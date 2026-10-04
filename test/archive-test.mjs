import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.join(os.tmpdir(), `rewind-archive-test-${process.pid}-${Date.now()}`)
process.env.REWIND_HOME = path.join(root, "home")
process.env.REWIND_CONFIG_DIR = path.join(root, "config")
delete process.env.REWIND_VAULT
await fsp.mkdir(process.env.REWIND_HOME, { recursive: true })

const config = await import("../lib/config.mjs")
const store = await import("../lib/store.mjs")

const FAKE = new URL("./fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const foreign = (value) => value.split(path.sep).join("/")
const insensitive = process.platform === "win32" || process.platform === "darwin"

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

await check("autoArchive no longer asks about folders at all", async () => {
  const text = await fsp.readFile(new URL("../lib/store.mjs", import.meta.url), "utf8")
  const start = text.indexOf("export async function autoArchive")
  assert.ok(start > 0, "autoArchive should exist")
  const body = text.slice(start, text.indexOf("\nexport ", start + 1))
  assert.equal(
    /directory\s+IN\s*\(/i.test(body),
    false,
    "an SQL IN list never matches opencode's forward slashes, and there is no folder to match now anyway",
  )
  assert.equal(
    /index\.projects/.test(body),
    false,
    "archiving must not depend on a registered project",
  )
  assert.equal(
    /folderKey/.test(body),
    false,
    "there is no folder comparison left to make",
  )
})

await check("planAutoArchive takes rows, not projects", () => {
  const rows = [{ id: "ses_abc123", title: "Fix the thing", directory: "", messages: 3 }]
  const plan = store.planAutoArchive(rows, [], 10)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].label, "fix-the-thing-c123")
})

await check("planAutoArchive keeps a session with no directory", () => {
  // The whole point: opencode does not always record a directory, and a session
  // still happened. Requiring a folder is what used to lose them.
  const rows = [{ id: "ses_ddd444", title: "No folder", directory: "", messages: 1 }]
  assert.equal(store.planAutoArchive(rows, [], 10).length, 1)
})

await check("planAutoArchive skips rows that are already archived", () => {
  const rows = [
    { id: "ses_aaa111", title: "One", directory: "", messages: 1 },
    { id: "ses_bbb222", title: "Two", directory: "", messages: 1 },
  ]
  const plan = store.planAutoArchive(rows, ["ses_aaa111"], 10)
  assert.deepEqual(
    plan.map((item) => item.row.id),
    ["ses_bbb222"],
  )
})

await check("planAutoArchive honours one global cap", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `ses_x${i}000`,
    title: `Session ${i}`,
    directory: "",
    messages: 1,
  }))
  assert.equal(store.planAutoArchive(rows, [], 2).length, 2)
})

await check("planAutoArchive re-archives a session opencode has touched since the copy", () => {
  const row = { id: "ses_live01", title: "Still going", directory: "", messages: 4, timeUpdated: 2_000 }
  const plan = store.planAutoArchive([row], [{ sessionID: "ses_live01", label: "still-going-e01", savedAt: 1_000 }], 10, 0)
  assert.equal(plan.length, 1, "a session that moved on should be saved again, not left frozen at its first copy")
  assert.equal(plan[0].refresh, true)
  assert.equal(plan[0].label, "still-going-e01", "the label must be reused so the refresh overwrites rather than orphans")
})

await check("planAutoArchive leaves an archive alone inside the refresh window", () => {
  const row = { id: "ses_live02", title: "Quiet", directory: "", messages: 4, timeUpdated: 1_100 }
  const seen = [{ sessionID: "ses_live02", label: "quiet-e02", savedAt: 1_000 }]
  assert.deepEqual(store.planAutoArchive([row], seen, 10, 300_000), [], "recently saved, nothing to do")
  assert.equal(store.planAutoArchive([row], seen, 10, 0).length, 1, "same row is stale once the window closes")
})

await check("a refresh does not eat the budget", () => {
  const rows = [
    { id: "ses_old000", title: "Old", directory: "", messages: 1, timeUpdated: 5_000 },
    { id: "ses_new000", title: "New", directory: "", messages: 1, timeUpdated: 4_000 },
  ]
  const seen = [{ sessionID: "ses_old000", label: "old-0000", savedAt: 1_000 }]
  const plan = store.planAutoArchive(rows, seen, 1, 0)
  assert.deepEqual(
    plan.map((item) => item.row.id),
    ["ses_old000", "ses_new000"],
    "the refresh is free, so the new session still fits in a budget of one",
  )
})

await check("saved sessions carry no project, just where they ran", async () => {
  const vault = path.join(root, "entry-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  await store.upsertSession({
    label: "cloudflare-migration-c123",
    sessionID: "ses_abc123",
    title: "Cloudflare migration",
    directory: path.join(root, "code", "app"),
    file: "sessions/cloudflare-migration-c123--ses_abc123.json.gz",
    savedAt: Date.now(),
    messages: 12,
    bytes: 4242,
  })
  const found = (await store.readIndex()).sessions.find((item) => item.sessionID === "ses_abc123")
  assert.equal(found.project, undefined)
  assert.equal(found.directory, path.join(root, "code", "app"))
})

await check("an index written by an older version still reads", async () => {
  const vault = path.join(root, "legacy-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  await fsp.writeFile(
    path.join(vault, "index.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "old", name: "Old", folder: "C:/code/app" }],
      sessions: [{ sessionID: "ses_old01", label: "old", project: "Old", savedAt: 1_000 }],
    }),
  )
  const index = await store.readIndex()
  assert.equal(index.projects, undefined, "the project concept is gone from the shape")
  assert.equal(index.sessions.length, 1, "but the saved sessions survive")
})

await check("autoArchive exports every session, whatever folder it ran in", async () => {
  const vault = path.join(root, "live-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const here = path.join(root, "code", "live")
  const elsewhere = path.join(root, "somewhere-else")
  await fsp.mkdir(here, { recursive: true })

  process.env.OPENCODE_BIN = FAKE
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_dead001", title: "Deploy the thing", directory: foreign(here), messages: 9 },
    { id: "ses_dead002", title: "Unrelated", directory: elsewhere, messages: 1 },
    { id: "ses_dead003", title: "No folder at all", directory: "", messages: 1 },
  ])

  const result = await store.autoArchive()
  assert.equal(result.error, undefined)
  assert.equal(result.saved.length, 3, `expected every session archived, got ${JSON.stringify(result.error || result.saved)}`)
  assert.deepEqual(
    result.saved.map((item) => item.sessionID).sort(),
    ["ses_dead001", "ses_dead002", "ses_dead003"],
  )
  assert.equal(result.saved[0].project, undefined, "nothing is filed under a project any more")
  assert.ok(fs.existsSync(path.join(vault, "sessions", "deploy-the-thing-d001--ses_dead001.json.gz")))

  // A second pass must not archive the same sessions again.
  const again = await store.autoArchive()
  assert.deepEqual(again.saved, [])
})

await check("autoArchive rewrites the same file when a live session advances", async () => {
  const vault = path.join(root, "refresh-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  process.env.OPENCODE_BIN = FAKE
  const rows = [{ id: "ses_ref001", title: "Getting long", directory: "", messages: 4, timeUpdated: 1_000 }]
  const publish = () => { process.env.FAKE_OPENCODE_ROWS = JSON.stringify(rows) }
  publish()

  const first = await store.autoArchive({ refresh: 0 })
  assert.equal(first.saved.length, 1)
  assert.equal(first.refreshed.length, 0)
  const file = path.join(vault, "sessions", "getting-long-f001--ses_ref001.json.gz")
  assert.ok(fs.existsSync(file))

  assert.deepEqual((await store.autoArchive({ refresh: 0 })).refreshed, [], "nothing changed yet")

  rows[0].timeUpdated = Date.now() + 1_000
  publish()
  const second = await store.autoArchive({ refresh: 0 })
  assert.equal(second.saved.length, 0)
  assert.equal(second.refreshed.length, 1)
  const sessions = fs.readdirSync(path.join(vault, "sessions"))
  assert.equal(sessions.length, 1, `a refresh must overwrite, not accumulate: ${sessions.join(", ")}`)
})

await check("clearVault drops every archive, snapshot and index entry", async () => {
  const vault = path.join(root, "wipe-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  await store.upsertSession({
    label: "keep-0001",
    sessionID: "ses_wipe01",
    title: "Keep",
    directory: "",
    file: "sessions/keep-0001--ses_wipe01.json.gz",
    savedAt: Date.now(),
    messages: 1,
    bytes: 10,
  })
  await fsp.mkdir(path.join(vault, "db"), { recursive: true })
  await fsp.writeFile(path.join(vault, "db", "opencode-20260101.db"), "not really a database")
  await fsp.mkdir(path.join(vault, "sessions"), { recursive: true })
  await fsp.writeFile(path.join(vault, "sessions", "keep-0001--ses_wipe01.json.gz"), "archive")

  const before = await store.vaultStats()
  assert.equal(before.sessions, 1)
  assert.equal(before.snapshots, 1)

  const cleared = await store.clearVault()
  assert.equal(cleared.removed, 1)

  const after = await store.vaultStats()
  assert.equal(after.sessions, 0)
  assert.equal(after.snapshots, 0)
  assert.equal(after.bytes, 0)
  assert.deepEqual((await store.readIndex()).sessions, [])
  assert.ok(!fs.existsSync(path.join(vault, "db", "opencode-20260101.db")), "a snapshot is history too")
})

await check("opencodeRunning answers a question rather than throwing", async () => {
  const running = await store.opencodeRunning()
  assert.ok(running === true || running === false || running === null, `unexpected probe result: ${running}`)
})

await check("clearOpencodeHistory deletes one statement at a time and then shrinks the file", async () => {
  const text = await fsp.readFile(new URL("../lib/store.mjs", import.meta.url), "utf8")
  const start = text.indexOf("export async function clearOpencodeHistory")
  assert.ok(start > 0, "clearOpencodeHistory should exist")
  const body = text.slice(start, text.indexOf("\nexport ", start + 1))

  assert.ok(
    /DELETE FROM event_sequence/.test(body) && /DELETE FROM session/.test(body),
    "event_sequence cascades to event, session cascades to message/part/todo",
  )
  assert.equal(
    /DELETE FROM[^;]*;[^;]*DELETE FROM/.test(body),
    false,
    "opencode's shell ignores everything after a semicolon, so each DELETE needs its own invocation",
  )
  assert.ok(
    body.indexOf("wal_checkpoint(TRUNCATE)") > body.lastIndexOf("DELETE FROM"),
    "the space only comes back once the deletes are flushed to the main file",
  )
  assert.ok(
    body.indexOf("VACUUM") > body.lastIndexOf("DELETE FROM") && body.lastIndexOf("wal_checkpoint(TRUNCATE)") > body.indexOf("VACUUM"),
    "in WAL mode VACUUM writes into the log, so it needs a checkpoint after it too",
  )
  assert.equal(
    /DELETE FROM\s+(project|workspace)/i.test(body),
    false,
    "projects and workspaces are configuration, not history",
  )
})

await check("startLiveArchive fills the vault without waiting for opencode to exit", async () => {
  const vault = path.join(root, "timer-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  process.env.OPENCODE_BIN = FAKE
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_time01", title: "Running now", directory: "", messages: 2, timeUpdated: 1_000 },
  ])

  const problems = []
  const stop = store.startLiveArchive({ intervalMs: 1000, refresh: 0, onError: (error) => problems.push(error) })
  // Wait on the index entry, not the .gz on disk: exportSessionTo writes the file
  // before upsertSession records it, so the file can appear while the index is
  // still being updated. The index is the commit point.
  const entry = async () => (await store.readIndex()).sessions.find((item) => item.sessionID === "ses_time01")
  try {
    const deadline = Date.now() + 20_000
    while (!(await entry()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const saved = await entry()
    assert.ok(
      saved,
      `the vault should fill in on its own, so a hard power-off loses nothing${
        problems.length ? `; background errors: ${problems.map((item) => item.message).join("; ")}` : ""
      }`,
    )
    assert.ok(fs.existsSync(store.entryFile(saved)), `archive missing at ${store.entryFile(saved)}`)
    const savedAt = saved.savedAt

    stop()
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const after = await entry()
    assert.equal(after.savedAt, savedAt, "stop() should halt the timer once opencode has exited")
  } finally {
    stop()
  }
})

await check("startLiveArchive never holds the process open", () => {
  // A background timer that is not unref'd would keep node running after the TUI
  // exits, turning every `rewind` invocation into a process that never returns.
  const text = fs.readFileSync(new URL("../lib/store.mjs", import.meta.url), "utf8")
  const start = text.indexOf("export function startLiveArchive")
  assert.ok(start > 0, "startLiveArchive should exist")
  const body = text.slice(start, text.indexOf("\nexport ", start + 1))
  assert.ok(/unref\(\)/.test(body), "the interval must be unref'd")
})

await check("exportSessionTo subscribes to close before awaiting the pipeline", async () => {
  // Deterministic guard. Whether the race actually fires depends on how the
  // platform schedules process exit against the pipeline settling, so the
  // timing test below can pass on a slow-spawn platform. The ordering is the
  // actual invariant: a `close` listener attached after the await is waiting on
  // an event that may already have happened.
  const text = await fsp.readFile(new URL("../lib/store.mjs", import.meta.url), "utf8")
  const start = text.indexOf("export async function exportSessionTo")
  assert.ok(start > 0, "exportSessionTo should exist")
  const body = text.slice(start, text.indexOf("\nexport ", start + 1))
  const subscribed = body.search(/child\.(on|once)\("close"/)
  const awaited = body.indexOf("await pipeline(")
  assert.ok(subscribed > 0, "exportSessionTo should listen for close")
  assert.ok(awaited > 0, "exportSessionTo should await the pipeline")
  assert.ok(
    subscribed < awaited,
    "the close listener must be attached before the pipeline is awaited, or a fast-exiting child deadlocks",
  )
})

await check("exportSessionTo survives a child that exits before the pipe drains", async () => {
  const vault = path.join(root, "race-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  process.env.FAKE_OPENCODE_SILENT = "1"
  try {
    // Regression: exportSessionTo used to attach its `close` listener after
    // awaiting the pipeline. A child that writes nothing exits first, so that
    // listener waited on an event that had already fired and never resolved.
    const dest = path.join(vault, "sessions", "silent--ses_silent.json.gz")
    const done = await Promise.race([
      store.exportSessionTo("ses_silent", dest),
      new Promise((_, reject) => setTimeout(() => reject(new Error("exportSessionTo never settled")), 10000)),
    ])
    assert.equal(done, dest)
  } finally {
    delete process.env.FAKE_OPENCODE_SILENT
  }
})

await fsp.rm(root, { recursive: true, force: true })

process.stdout.write(`\n${passed + failed} archive checks passed${failed ? `, ${failed} FAILED` : ""}\n`)
process.exitCode = failed ? 1 : 0