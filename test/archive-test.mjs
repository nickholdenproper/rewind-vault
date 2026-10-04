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

await check("planAutoArchive gives a duplicated folder to the most recently used project", () => {
  // An index written by an older version can still hold two names for one
  // folder. Array order must not decide this, or the project the user just
  // added silently receives nothing and looks broken.
  const folder = path.join(root, "code", "app")
  const projects = [
    { id: "old", name: "Old", folder, lastUsed: 1_000 },
    { id: "new", name: "New", folder, lastUsed: 9_000 },
  ]
  const rows = [{ id: "ses_dup111", title: "Work", directory: foreign(folder), messages: 1 }]
  assert.equal(store.planAutoArchive(projects, rows, [], 10)[0].project.name, "New")
  assert.deepEqual(
    store.planAutoArchive([projects[1], projects[0]], rows, [], 10).map((item) => item.project.name),
    ["New"],
    "order in the array must not change the winner",
  )
})

await check("duplicateFolders names the projects sharing a folder", () => {
  const folder = path.join(root, "code", "app")
  const projects = [
    { id: "a", name: "A", folder },
    { id: "b", name: "B", folder: foreign(folder) },
    { id: "c", name: "C", folder: path.join(root, "code", "c") },
  ]
  assert.deepEqual(store.duplicateFolders(projects), [["A", "B"]])
  assert.deepEqual(store.duplicateFolders([projects[0], projects[2]]), [])
})

await check("registering the same folder again renames the project instead of forking it", async () => {
  const vault = path.join(root, "alias-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "shared")
  await fsp.mkdir(folder, { recursive: true })

  await store.upsertProject({ name: "First", folder })
  await store.upsertProject({ name: "Second", folder: foreign(folder) })
  const projects = (await store.readIndex()).projects
  assert.equal(projects.length, 1, `one folder is one project, got ${projects.map((p) => p.name).join(", ")}`)
  assert.equal(projects[0].name, "Second", "the newest name wins")
  assert.deepEqual(store.duplicateFolders(projects), [])
})

await check("re-registering a folder collapses aliases left by an older version", async () => {
  const vault = path.join(root, "legacy-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "legacy")
  await fsp.mkdir(folder, { recursive: true })

  // Write the index by hand: upsertProject no longer creates these, but a vault
  // that already has them must heal rather than stay broken.
  await fsp.writeFile(
    path.join(vault, "index.json"),
    JSON.stringify({
      projects: ["Jumanji", "james", "runpod"].map((name, i) => ({
        id: name.toLowerCase(),
        name,
        folder,
        createdAt: 1_000 + i,
        lastUsed: 1_000 + i,
      })),
      sessions: [],
    }),
  )
  assert.deepEqual(store.duplicateFolders((await store.readIndex()).projects).flat().sort(), ["Jumanji", "james", "runpod"])

  await store.upsertProject({ name: "runpod", folder })
  const index = await store.readIndex()
  assert.deepEqual(index.projects.map((p) => p.name), ["runpod"])
  assert.deepEqual(store.duplicateFolders(index.projects), [])
})

await check("collapsing aliases relabels every archived session, not just one", async () => {
  const vault = path.join(root, "alias-sessions")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "many")

  // The state this bug produced: one folder under three names, with sessions
  // already filed under each of them.
  await fsp.writeFile(
    path.join(vault, "index.json"),
    JSON.stringify({
      projects: ["Jumanji", "james", "runpod"].map((name, i) => ({
        id: name.toLowerCase(),
        name,
        folder,
        createdAt: 1_000 + i,
        lastUsed: 1_000 + i,
      })),
      sessions: ["Jumanji", "james", "runpod"].map((name, i) => ({
        label: `work-000${i}`,
        sessionID: `ses_ses00${i}`,
        title: `Work ${i}`,
        directory: folder,
        project: name,
        file: `sessions/work-000${i}--ses_ses00${i}.json.gz`,
        savedAt: 2_000 + i,
        messages: 1,
        bytes: 1,
      })),
    }),
  )

  await store.upsertProject({ name: "runpod", folder })
  const index = await store.readIndex()
  assert.deepEqual(index.projects.map((p) => p.name), ["runpod"])
  assert.equal(index.sessions.length, 3, "none should be dropped")
  assert.deepEqual(
    index.sessions.map((s) => s.project),
    ["runpod", "runpod", "runpod"],
    "no session should be left filed under a name that no longer exists",
  )
})

await check("renaming a project carries its archived sessions across", async () => {
  const vault = path.join(root, "rename-vault")
  store.setVault(vault)
  await config.prepareVault(vault)
  const folder = path.join(root, "code", "renamed")
  await fsp.mkdir(folder, { recursive: true })
  await store.upsertProject({ name: "Before", folder })

  process.env.OPENCODE_BIN = FAKE
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_ren001", title: "Work", directory: foreign(folder), messages: 2, timeUpdated: 1_000 },
  ])
  const saved = await store.archiveSessionById("ses_ren001", { refresh: 0 })
  assert.equal(saved.project, "Before")

  await store.upsertProject({ name: "After", folder })
  const [entry] = (await store.readIndex()).sessions
  assert.equal(entry.project, "After", "the load screen groups by this name, so it has to move")
  assert.equal(entry.sessionID, "ses_ren001")
  assert.ok(fs.existsSync(store.entryFile(entry)), "the archive file itself must not move")
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

await check("planAutoArchive re-archives a session opencode has touched since the copy", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const row = { id: "ses_live01", title: "Still going", directory: folder, messages: 4, timeUpdated: 2_000 }
  const plan = store.planAutoArchive(projects, [row], [{ sessionID: "ses_live01", label: "still-going-e01", savedAt: 1_000 }], 10, 0)
  assert.equal(plan.length, 1, "a session that moved on should be saved again, not left frozen at its first copy")
  assert.equal(plan[0].refresh, true)
  assert.equal(plan[0].label, "still-going-e01", "the label must be reused so the refresh overwrites rather than orphans")
})

await check("planAutoArchive leaves an archive alone inside the refresh window", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const row = { id: "ses_live02", title: "Quiet", directory: folder, messages: 4, timeUpdated: 1_100 }
  const seen = [{ sessionID: "ses_live02", label: "quiet-e02", savedAt: 1_000 }]
  assert.deepEqual(store.planAutoArchive(projects, [row], seen, 10, 300_000), [], "recently saved, nothing to do")
  assert.equal(store.planAutoArchive(projects, [row], seen, 10, 0).length, 1, "same row is stale once the window closes")
})

await check("a refresh does not eat the per-project budget", () => {
  const folder = path.join(root, "code", "app")
  const projects = [{ id: "app", name: "app", folder }]
  const rows = [
    { id: "ses_old000", title: "Old", directory: folder, messages: 1, timeUpdated: 5_000 },
    { id: "ses_new000", title: "New", directory: folder, messages: 1, timeUpdated: 4_000 },
  ]
  const seen = [{ sessionID: "ses_old000", label: "old-0000", savedAt: 1_000 }]
  const plan = store.planAutoArchive(projects, rows, seen, 1, 0)
  assert.deepEqual(
    plan.map((item) => item.row.id),
    ["ses_old000", "ses_new000"],
    "the refresh is free, so the new session still fits in a budget of one",
  )
})

await check("autoArchive rewrites the same file when a live session advances", async () => {
  const vault = path.join(root, "refresh-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const folder = path.join(root, "code", "refresh")
  await fsp.mkdir(folder, { recursive: true })
  await store.upsertProject({ name: "Refresh", folder })

  process.env.OPENCODE_BIN = FAKE
  const rows = [{ id: "ses_ref001", title: "Getting long", directory: foreign(folder), messages: 4, timeUpdated: 1_000 }]
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

await check("startLiveArchive fills the vault without waiting for opencode to exit", async () => {
  const vault = path.join(root, "timer-vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const folder = path.join(root, "code", "timer")
  await fsp.mkdir(folder, { recursive: true })
  await store.upsertProject({ name: "Timer", folder })

  process.env.OPENCODE_BIN = FAKE
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { id: "ses_time01", title: "Running now", directory: foreign(folder), messages: 2, timeUpdated: 1_000 },
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
