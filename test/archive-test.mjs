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

await check("folderKey folds the separator the other platform would use", () => {
  const native = path.resolve(root, "code", "app")
  assert.equal(store.folderKey(native), store.folderKey(foreign(native)))
  assert.equal(store.folderKey(native), store.folderKey(`${native}${path.sep}`))
  assert.equal(store.folderKey(native), store.folderKey(`${foreign(native)}/`))
})

await check("folderKey folds case only where the filesystem does", () => {
  const native = path.resolve(root, "code", "App")
  if (insensitive) assert.equal(store.folderKey(native), store.folderKey(native.toLowerCase()))
  else assert.notEqual(store.folderKey(native), store.folderKey(native.toLowerCase()))
})

await check("a project folder matches a session stored with the other separator", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const row = { id: "ses_abc123", title: "Fix the thing", directory: foreign(folder), messages: 3 }
  const plan = store.planAutoArchive(projects, [row], [], 10)
  assert.equal(plan.length, 1, "the forward-slash row should have matched the backslash folder")
  assert.equal(plan[0].project.name, "app")
  assert.equal(plan[0].label, "fix-the-thing-c123")
})

await check("autoArchive does not prefilter directories inside SQL", async () => {
  const text = await fsp.readFile(new URL("../lib/store.mjs", import.meta.url), "utf8")
  const start = text.indexOf("export async function autoArchive")
  assert.ok(start > 0, "autoArchive should exist")
  const body = text.slice(start, text.indexOf("\nexport ", start + 1))
  assert.equal(
    /directory\s+IN\s*\(/i.test(body),
    false,
    "autoArchive must match folders in JavaScript; an SQL IN list never matches opencode's forward slashes",
  )
})

await check("planAutoArchive skips rows that are already archived", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const rows = [
    { id: "ses_aaa111", title: "One", directory: folder, messages: 1 },
    { id: "ses_bbb222", title: "Two", directory: folder, messages: 1 },
  ]
  const plan = store.planAutoArchive(projects, rows, ["ses_aaa111"], 10)
  assert.deepEqual(
    plan.map((item) => item.row.id),
    ["ses_bbb222"],
  )
})

await check("planAutoArchive honours the per-project cap", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `ses_x${i}000`,
    title: `Session ${i}`,
    directory: foreign(folder),
    messages: 1,
  }))
  assert.equal(store.planAutoArchive(projects, rows, [], 2).length, 2)
})

await check("planAutoArchive leaves folders that are not projects alone", () => {
  const projects = [{ id: "app", name: "app", folder: path.join(root, "code", "app") }]
  const rows = [{ id: "ses_ccc333", title: "Elsewhere", directory: path.join(root, "other"), messages: 1 }]
  assert.deepEqual(store.planAutoArchive(projects, rows, [], 10), [])
})

await check("planAutoArchive ignores rows with no directory", () => {
  const projects = [{ id: "app", name: "app", folder: path.join(root, "code", "app") }]
  const rows = [{ id: "ses_ddd444", title: "No folder", directory: "", messages: 1 }]
  assert.deepEqual(store.planAutoArchive(projects, rows, [], 10), [])
})

await check("autoArchive is a no-op when no project is registered", async () => {
  const vault = path.join(root, "empty-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const result = await store.autoArchive()
  assert.deepEqual(result.saved, [])
  assert.deepEqual(result.missing, [])
  assert.equal(result.error, undefined)
})

await check("missingFolders reports projects whose folder is gone", async () => {
  const vault = path.join(root, "missing-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const gone = path.join(root, "not-here")
  const present = path.join(root, "code", "app")
  await fsp.mkdir(present, { recursive: true })
  await store.upsertProject({ name: "Gone", folder: gone })
  await store.upsertProject({ name: "Here", folder: present })
  assert.deepEqual(store.missingFolders((await store.readIndex()).projects), [gone])
})

await check("projects round trip through the index", async () => {
  const vault = path.join(root, "project-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "app")
  await fsp.mkdir(folder, { recursive: true })

  const saved = await store.upsertProject({ name: "My App", folder })
  assert.equal(saved.id, "my-app")
  assert.equal(saved.folder, path.resolve(folder))

  const again = await store.upsertProject({ name: "My App", folder })
  assert.equal(again.createdAt, saved.createdAt, "createdAt should survive a re-save")
  assert.ok(again.lastUsed >= saved.lastUsed)

  const index = await store.readIndex()
  assert.equal(index.projects.length, 1)
  assert.equal(index.sessions.length, 0)
})

await check("an index without projects still reads", async () => {
  const vault = path.join(root, "legacy-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  await fsp.writeFile(path.join(vault, "index.json"), JSON.stringify({ version: 1, sessions: [] }))
  const index = await store.readIndex()
  assert.deepEqual(index.projects, [])
  assert.deepEqual(index.sessions, [])
})

await check("saved sessions record the project they came from", async () => {
  const vault = path.join(root, "entry-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  await store.upsertSession({
    label: "cloudflare-migration-c123",
    sessionID: "ses_abc123",
    title: "Cloudflare migration",
    directory: path.join(root, "code", "app"),
    project: "My App",
    file: "sessions/cloudflare-migration-c123--ses_abc123.json.gz",
    savedAt: Date.now(),
    messages: 12,
    bytes: 4242,
  })
  const found = (await store.readIndex()).sessions.find((item) => item.sessionID === "ses_abc123")
  assert.equal(found.project, "My App")
})

await check("autoArchive exports and records a session from a forward-slash row", async () => {
  const vault = path.join(root, "live-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const folder = path.join(root, "code", "live")
  await fsp.mkdir(folder, { recursive: true })
  await store.upsertProject({ name: "Live", folder })

  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_dead001", title: "Deploy the thing", directory: foreign(folder), messages: 9 },
    { id: "ses_dead002", title: "Unrelated", directory: path.join(root, "somewhere-else"), messages: 1 },
  ])
  process.env.OPENCODE_BIN = FAKE

  const result = await store.autoArchive()
  assert.equal(result.error, undefined)
  assert.equal(result.saved.length, 1, `expected one archived session, got ${JSON.stringify(result.error || result.saved)}`)
  assert.equal(result.saved[0].sessionID, "ses_dead001")
  assert.equal(result.saved[0].project, "Live")
  assert.equal(result.saved[0].label, "deploy-the-thing-d001")
  assert.ok(fs.existsSync(path.join(vault, "sessions", "deploy-the-thing-d001--ses_dead001.json.gz")))

  // A second pass must not archive the same session again.
  const again = await store.autoArchive()
  assert.deepEqual(again.saved, [])
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
