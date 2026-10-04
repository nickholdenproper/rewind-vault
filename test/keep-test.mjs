import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import path from "node:path"

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

await check("clearing history keeps the session you are in, and its subagents", async () => {
  const root = path.join(import.meta.dirname, "..", ".tmp-keep-test")
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true })

  const store = await import("../lib/store.mjs")
  const config = await import("../lib/config.mjs")
  const vault = path.join(root, "vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const sqlLog = path.join(root, "sql.log")
  const previous = {
    bin: process.env.OPENCODE_BIN,
    rows: process.env.FAKE_OPENCODE_ROWS,
    tree: process.env.FAKE_OPENCODE_TREE,
    log: process.env.FAKE_OPENCODE_SQL_LOG,
    home: process.env.REWIND_HOME,
    cfg: process.env.REWIND_CONFIG_DIR,
  }
  process.env.OPENCODE_BIN = path.join(import.meta.dirname, "fixtures", "fake-opencode.mjs")
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { sessions: 4, messages: 40, parts: 400, todos: 4, events: 4000 },
  ])
  // A parent, two levels of subagent under it, and two sessions that are not it.
  process.env.FAKE_OPENCODE_TREE = JSON.stringify([
    { id: "ses_live", parent_id: null },
    { id: "ses_sub", parent_id: "ses_live" },
    { id: "ses_subsub", parent_id: "ses_sub" },
    { id: "ses_old", parent_id: null },
    { id: "ses_other", parent_id: null },
  ])
  process.env.FAKE_OPENCODE_SQL_LOG = sqlLog

  try {
    // No active-session.json, so this exercises the fallback to the most
    // recently updated session as well as the subtree walk.
    process.env.REWIND_CONFIG_DIR = path.join(root, "config")
    process.env.REWIND_HOME = path.join(root, "home")
    const active = await store.activeSessionId()
    assert.equal(active, "ses_live", "should fall back to the newest session")

    // Now record it explicitly, the way the plugin does on every idle.
    await store.noteActiveSession("ses_live")
    assert.equal(await store.activeSessionId(), "ses_live")

    await store.clearOpencodeHistory({ keep: [active] })

    const sql = await fsp.readFile(sqlLog, "utf8")
    const deleteSession = /DELETE FROM session[^\n]*/.exec(sql)?.[0] || ""
    const deleteEvents = /DELETE FROM event_sequence[^\n]*/.exec(sql)?.[0] || ""

    for (const [name, statement] of [
      ["session", deleteSession],
      ["event_sequence", deleteEvents],
    ]) {
      assert.ok(statement.includes("NOT IN"), `${name} delete should exclude the kept ids: ${statement}`)
      assert.ok(statement.includes("'ses_live'"), `${name} delete should keep the live session: ${statement}`)
      assert.ok(statement.includes("'ses_sub'"), `${name} delete should keep a subagent: ${statement}`)
      assert.ok(
        statement.includes("'ses_subsub'"),
        `${name} delete should keep a grandchild too, or the parent is left unreadable: ${statement}`,
      )
      assert.equal(
        statement.includes("'ses_old'"),
        false,
        `${name} delete should not spare sessions nobody is in: ${statement}`,
      )
    }

    assert.equal(
      /DELETE FROM\s+(project|workspace)/i.test(sql),
      false,
      "projects and workspaces are configuration, not history",
    )
  } finally {
    for (const [key, value] of [
      ["OPENCODE_BIN", previous.bin],
      ["FAKE_OPENCODE_ROWS", previous.rows],
      ["FAKE_OPENCODE_TREE", previous.tree],
      ["FAKE_OPENCODE_SQL_LOG", previous.log],
      ["REWIND_HOME", previous.home],
      ["REWIND_CONFIG_DIR", previous.cfg],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fsp.rm(root, { recursive: true, force: true })
  }
})

await check("a clear with nothing to keep still deletes every row", async () => {
  const root = path.join(import.meta.dirname, "..", ".tmp-keep-test2")
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true })

  const store = await import("../lib/store.mjs")
  const config = await import("../lib/config.mjs")
  const vault = path.join(root, "vault")
  store.setVault(vault)
  await config.prepareVault(vault)

  const sqlLog = path.join(root, "sql.log")
  const previous = {
    bin: process.env.OPENCODE_BIN,
    rows: process.env.FAKE_OPENCODE_ROWS,
    tree: process.env.FAKE_OPENCODE_TREE,
    log: process.env.FAKE_OPENCODE_SQL_LOG,
  }
  process.env.OPENCODE_BIN = path.join(import.meta.dirname, "fixtures", "fake-opencode.mjs")
  process.env.FAKE_OPENCODE_ROWS = JSON.stringify([
    { sessions: 2, messages: 20, parts: 200, todos: 2, events: 2000 },
  ])
  process.env.FAKE_OPENCODE_TREE = JSON.stringify([
    { id: "ses_live", parent_id: null },
    { id: "ses_old", parent_id: null },
  ])
  process.env.FAKE_OPENCODE_SQL_LOG = sqlLog

  try {
    const done = await store.clearOpencodeHistory()
    const sql = await fsp.readFile(sqlLog, "utf8")
    assert.ok(
      /DELETE FROM session;/.test(sql) || /DELETE FROM session\r?\n/.test(sql),
      `with no keep set there is nothing to exclude: ${/DELETE FROM session.*/.exec(sql)?.[0]}`,
    )
    assert.equal(/DELETE FROM session[^\n]*NOT IN/.test(sql), false, "an empty keep set must not produce NOT IN ()")
    assert.equal(done.kept, 0)
  } finally {
    for (const [key, value] of [
      ["OPENCODE_BIN", previous.bin],
      ["FAKE_OPENCODE_ROWS", previous.rows],
      ["FAKE_OPENCODE_TREE", previous.tree],
      ["FAKE_OPENCODE_SQL_LOG", previous.log],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fsp.rm(root, { recursive: true, force: true })
  }
})
process.stdout.write(`${passed} keep checks passed\n`)
if (failed) process.exitCode = 1
