#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import {
  configDir,
  configuredVault,
  configPath,
  defaultVault,
  describe,
  prepareVault,
  readConfig,
  vaultIsEmpty,
  vaultProblem,
  writeConfig,
} from "./lib/config.mjs"
import * as plugin from "./lib/plugin.mjs"
import * as store from "./lib/store.mjs"
import {
  BYLINE,
  dayGroup,
  dialog,
  formatBytes,
  folderName,
  info,
  notify,
  promptText,
  relativeTime,
  withSpinner,
} from "./lib/ui.mjs"

const SUBCOMMAND = "history"
function fallbackDir() {
  return process.cwd()
}

async function ensureVault({ interactive = true } = {}) {
  const config = await readConfig()
  const wanted = configuredVault(config)
  if (wanted) {
    store.setVault(await prepareVault(wanted))
    return { vault: store.VAULT, asked: false }
  }

  const suggestion = defaultVault()
  let chosen = suggestion
  if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await promptText({
      title: "Where should rewind keep your saved sessions?",
      hint: "enter keeps this path",
      initial: suggestion,
      allowEmpty: true,
      validate: (value) => (value.trim() ? vaultProblem(value) : vaultProblem(suggestion)),
    })
    if (answer === null) return { vault: undefined, asked: true }
    chosen = answer.trim() || suggestion
  }

  const vault = await prepareVault(chosen)
  store.setVault(vault)
  await writeConfig({ ...config, vault })
  return { vault, asked: true }
}

function groupBy(items, key) {
  const groups = []
  const seen = new Map()
  for (const item of items) {
    const label = key(item)
    let group = seen.get(label)
    if (!group) {
      group = { label, items: [] }
      seen.set(label, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

function totalBytes(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
}

/**
 * Archived sessions group by the day they were saved. There is no project to
 * belong to any more: a session is kept because it happened, wherever it ran.
 */
function savedGroups(entries) {
  return groupBy(entries, (entry) => dayGroup(entry.savedAt)).map((group) => ({
    label: group.label,
    items: group.items.map((entry) => ({
      value: entry,
      title: entry.label,
      footer: `${folderName(entry.directory)} · ${entry.messages || 0} msgs`,
      preview: `${formatBytes(entry.bytes || 0)} · saved ${relativeTime(entry.savedAt)} · ${entry.sessionID} · ${entry.directory || "unknown dir"}`,
    })),
  }))
}

async function loadFlow() {
  let entries = (await store.readIndex()).sessions
  if (entries.length === 0) {
    await notify(`No saved sessions in ${store.VAULT} yet — choose "Save a session" first.`)
    return null
  }

  let notice = ""
  for (;;) {
    const result = await dialog({
      title: "Load a session",
      byline: "",
      subheading: () => notice || `${store.VAULT}  ·  ${entries.length} saved  ·  ${formatBytes(totalBytes(entries))}`,
      groups: () => savedGroups(entries),
      empty: `No saved sessions in ${store.VAULT} yet`,
      hints: (state) => [
        { key: "enter", label: "open" },
        { key: "ctrl+r", label: "rename", armed: state.armed === "rename" },
        { key: "ctrl+d", label: "delete", armed: state.armed === "delete" },
      ],
      actions: [
        {
          id: "rename",
          key: "r",
          ctrl: true,
          run: (entry) => ({ close: { intent: "rename", entry } }),
        },
        {
          id: "delete",
          key: "d",
          ctrl: true,
          confirm: "Delete for good? ctrl+d again",
          run: async (entry, ctx) => {
            if (!ctx.armed) {
              ctx.arm()
              return undefined
            }
            await store.deleteArchive(entry)
            entries = entries.filter((item) => item.sessionID !== entry.sessionID)
            notice = `Deleted "${entry.label}".`
            ctx.rerender()
            return undefined
          },
        },
      ],
    })

    if (result.action === "rename") {
      const entry = result.value.entry
      const label = await promptText({
        title: `Rename "${entry.label}"`,
        hint: "letters, digits, spaces, . - _ only",
        initial: entry.label,
        validate: store.validateLabel,
      })
      if (label !== null) {
        const updated = await store.renameArchive(entry, label)
        entries = entries.map((item) => (item.sessionID === entry.sessionID ? updated : item))
        notice = `Renamed to "${updated.label}".`
      }
      continue
    }

    if (result.action !== "select") return null
    const picked = result.value
    let directory = picked.directory
    if (!directory || !fs.existsSync(directory)) {
      info("")
      info(`${picked.label} was saved in "${directory || "an unknown folder"}", which is not reachable.`)
      const answer = await promptText({
        title: "Folder to open opencode in (blank cancels):",
        initial: fallbackDir(),
        allowEmpty: true,
      })
      if (answer === null || !answer.trim()) return null
      directory = path.resolve(answer.trim())
      if (!fs.existsSync(directory)) {
        await notify(`That folder does not exist: ${directory}`)
        return null
      }
    }

    const imported = await withSpinner(`Restoring ${picked.label} (${picked.sessionID})`, () => store.importArchive(picked, directory))
    info(imported || "imported")
    return launchAndArchive(() => store.launchTui({ directory, sessionID: picked.sessionID }), "the restored session")
  }
}

/**
 * Archives anything new that belongs to a registered project and says what it
 * caught. Failures are printed rather than swallowed: a run that silently saved
 * nothing is indistinguishable from a run with nothing to save.
 */
async function archiveNew(label, note) {
  const result = await store.archiveNewSessions()
  info("")
  if (result.error) {
    info(`Could not save new sessions${label ? ` from ${label}` : ""}: ${result.error.message}`)
    return result
  }
  const fresh = result.saved || []
  const updated = result.refreshed || []
  if (fresh.length || updated.length) {
    const total = fresh.length + updated.length
    info(`Saved ${total} session${total === 1 ? "" : "s"}${label ? ` from ${label}` : ""}:`)
    for (const entry of fresh) info(`  ${entry.label}  (${entry.messages || 0} msgs)  new`)
    for (const entry of updated) info(`  ${entry.label}  (${entry.messages || 0} msgs)  updated`)
  }
  if (note) info(note)
  for (const folder of result.missing || []) {
    info(`Project folder is gone, so nothing new will save from it: ${folder}`)
  }
  return result
}

/**
 * Every path that starts opencode goes through here.
 *
 * Two layers of saving, because neither alone is enough. The interval keeps the
 * vault current *while* you work, so losing power costs you a couple of minutes
 * rather than the whole session -- waiting for a clean exit is not an option
 * when the machine simply stops. The archive after the child exits is still
 * there to catch the last few messages and to report what happened.
 */
async function launchAndArchive(launch, label, note) {
  let failure
  const stop = store.startLiveArchive({ onError: (error) => { failure = failure || error } })
  let code
  try {
    code = await launch()
  } finally {
    stop()
  }
  await archiveNew(label, note)
  if (failure) info(`A background save failed earlier and was retried: ${failure.message}`)
  return code
}

async function backupFlow() {
  try {
    info("Vacuuming a consistent snapshot of the session database …")
    const result = await store.backupDatabase()
    info(`Database snapshot → ${result.file} (${formatBytes(result.bytes)})`)
  } catch (error) {
    info(`Database backup failed: ${error.message}`)
    const source = (await store.dbFile().catch(() => "")) || store.guessDbFile() || "the opencode database"
    info(`Copy ${source} (plus -wal and -shm) to ${store.DB_DIR} while opencode is closed instead.`)
  }
  await notify("Done.")
}

/**
 * Wipes every opencode session and every rewind archive.
 *
 * The awkward part of this command is that it can only run when opencode is
 * closed, and opencode is usually the thing you are using when you reach for it.
 * So there are two ways out: `--when-closed` hands the job to a detached watcher
 * that fires the moment opencode exits, and `--wait` is that watcher. `--yes`
 * drops the typed confirmation, which only makes sense for the watcher, since
 * nothing can type into it.
 */
async function clearFlow({ yes = false, wait = false, whenClosed = false } = {}) {
  if (whenClosed) return armClearWatcher()

  if (wait) {
    // The watcher's own loop. Polling a process list every few seconds costs
    // nothing, and it needs no privileges and no IPC.
    process.stdout.write("rewind: waiting for opencode to exit\n")
    for (;;) {
      if (!(await store.opencodeRunning())) break
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    // opencode's last writes hit the disk as it exits; give the file handles a
    // moment to go away before opening the database for deletion.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // Past this point there is nothing to cancel.
    await fsp.rm(markerPath(), { force: true }).catch(() => {})
  } else {
    const running = await store.opencodeRunning()
    if (running) {
      // Asking the user to close opencode and then run this again is a worse
      // answer than just doing it: they are holding opencode to type the command
      // in the first place. Arm the watcher and let them close it whenever they
      // are done. Arming is the confirmation -- it is cancellable, and it prints
      // the pid to cancel with.
      return armClearWatcher()
    }
  }

  let counts
  try {
    counts = await store.historyCounts()
  } catch (error) {
    info(`Could not read the session database: ${error.message}`)
    await notify("Nothing was deleted.")
    await writeClearLog(`failed: could not read the session database: ${error.message}`)
    return
  }

  const stats = await store.vaultStats()
  if (counts.sessions === 0 && stats.sessions === 0) {
    info("Nothing to clear.")
    await notify("Nothing to clear.")
    await writeClearLog("nothing to clear")
    return
  }

  info(`opencode  ${counts.sessions} sessions, ${counts.messages} messages`)
  info(`rewind    ${stats.sessions} archives (${formatBytes(stats.bytes)}), ${stats.snapshots} snapshots`)
  info("A database snapshot is taken first, so this is reversible.")
  info("Projects and credentials are kept.")

  if (!yes) {
    const typed = await promptText({
      title: "Type DELETE to erase it all:",
      hint: "anything else cancels",
      initial: "",
      validate: () => undefined,
    })
    if (typed === null || typed.trim().toUpperCase() !== "DELETE") {
      info("Cancelled. Nothing was deleted.")
      await notify("Cancelled.")
      return
    }
  }

  try {
    await withSpinner("Snapshotting", () => store.backupDatabase())
    const before = await store.clearOpencodeHistory()
    await store.clearVault()
    info(`Deleted ${before.sessions} sessions and ${stats.sessions} archives.`)
    await notify("History cleared.")
    await writeClearLog(
      `cleared ${before.sessions} opencode sessions (${before.messages} messages, ${before.events} events) and ${stats.sessions} archives`,
    )
  } catch (error) {
    info(`Clear failed: ${error.message}`)
    await notify("Clear failed.")
    await writeClearLog(`failed: ${error.message}`)
  }
}

/**
 * A record of what the watcher did, since it runs with no terminal to print to.
 * Beside the config rather than in the vault, because the vault is what it wipes.
 */
async function writeClearLog(message) {
  const line = `${new Date().toISOString()}  ${message}\n`
  await fsp.appendFile(path.join(configDir(), "last-clear.log"), line, "utf8").catch(() => {})
  if (!process.stdout.isTTY) process.stdout.write(`rewind: ${message}\n`)
}

const markerPath = () => path.join(configDir(), "clear-watcher.json")

async function readWatcher() {
  try {
    return JSON.parse(await fsp.readFile(markerPath(), "utf8"))
  } catch {
    return null
  }
}

const pidAlive = (pid) =>
  new Promise((resolve) => {
    try {
      process.kill(pid, 0)
      resolve(true)
    } catch (error) {
      // EPERM means it is running and belongs to somebody else, which is alive.
      resolve(error.code === "EPERM")
    }
  })

/**
 * Hands the clear to a detached process that outlives this one.
 *
 * Detached with its own process group and no inherited streams, so closing
 * opencode -- the very thing that triggers the clear -- cannot take the watcher
 * down with it, and the watcher cannot hold a console open on the way out.
 *
 * The watcher runs confirmed. It has no terminal to type into, so leaving it
 * unconfirmed would mean it silently does nothing, and arming is deliberate
 * enough on its own: it prints what will happen and the pid to cancel with.
 */
async function armClearWatcher() {
  const armed = await readWatcher()
  if (armed && (await pidAlive(armed.pid))) {
    info(`A clear watcher is already armed (pid ${armed.pid}).`)
    info(`Stop it with: rewind history clear --cancel-watcher ${armed.pid}`)
    return 1
  }

  // bin/rewind.mjs is a sibling of this module, and it is the entry point:
  // launcher.mjs only exports main(), so spawning this file would start a
  // process that does nothing at all.
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin", "rewind.mjs")

  // The watcher's output goes to a file. It has no terminal, and a watcher that
  // dies quietly looks exactly like a watcher that is still waiting.
  const logFile = path.join(configDir(), "clear-watcher.log")
  const logFd = fs.openSync(logFile, "a")
  // The watcher must judge by the real process list, so the test/practice override
  // is stripped: a forced "running" here would leave it waiting forever.
  const childEnv = { ...process.env }
  delete childEnv.REWIND_ASSUME_OPENCODE_RUNNING
  const child = spawn(process.execPath, [entry, "history", "clear", "--wait", "--yes"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: childEnv,
  })
  fs.closeSync(logFd)
  child.unref()

  // The watcher gets cancelled by pid, and a bare pid proves nothing: it could be
  // any process that recycled the number. Recording the one actually spawned is
  // what makes `--cancel-watcher` safe to point at a number a human typed.
  await fsp.mkdir(configDir(), { recursive: true })
  await fsp.writeFile(
    markerPath(),
    `${JSON.stringify({ pid: child.pid, armedAt: Date.now() }, null, 2)}\n`,
  )

  info("")
  info("opencode is open, so this is armed to run the moment you close it.")
  info("No second command to remember.")
  info("")
  info("  every opencode session deleted")
  info("  every rewind archive deleted")
  info("  projects and credentials kept")
  info("  a snapshot is written first, so it is reversible")
  info("")
  info(`  watcher pid ${child.pid}`)
  info("  this session is deleted too, this conversation included")
  info(`  changed your mind: rewind history clear --cancel-watcher ${child.pid}`)
  info("")
  return 0
}

/**
 * Stops an armed watcher, for when arming it was the wrong call.
 *
 * Only ever kills a pid present in the watcher record, so a mistyped number
 * cannot take down an unrelated process.
 */
async function cancelWatcher(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) {
    info("usage: rewind history clear --cancel-watcher <pid>")
    return 1
  }

  const watcher = await readWatcher()
  if (!watcher || watcher.pid !== id) {
    info(`No clear watcher with pid ${id} is armed, so nothing was stopped.`)
    return 1
  }
  if (!(await pidAlive(id))) {
    await fsp.rm(markerPath(), { force: true })
    info(`Watcher ${id} had already exited. Nothing will be deleted.`)
    return 0
  }

  try {
    process.kill(id)
    await fsp.rm(markerPath(), { force: true })
    info(`Stopped watcher ${id}. Nothing will be deleted.`)
    return 0
  } catch (error) {
    info(`Could not stop ${id}: ${error.message}`)
    return 1
  }
}

async function listFlow() {
  const index = await store.readIndex()
  if (index.sessions.length === 0) {
    info(`No saved sessions in ${store.VAULT}.`)
    return 0
  }
  info(`${index.sessions.length} saved session(s) in ${store.VAULT}:`)
  for (const entry of index.sessions) {
    info(
      `  ${entry.label}\n    ${entry.sessionID}  ${entry.messages || 0} msgs  ${formatBytes(entry.bytes || 0)}  ${relativeTime(entry.savedAt)}\n    ${entry.directory || "unknown dir"}`,
    )
  }
  return 0
}

async function saveById(args) {
  const id = args[0]
  if (!id) {
    info("usage: rewind history save <sessionID> [name]")
    return 1
  }
  const rows = await store.dbQuery(
    `SELECT s.id AS id, s.title AS title, s.directory AS directory,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s WHERE s.id = '${String(id).replace(/'/g, "''")}'`,
  )
  if (rows.length === 0) {
    info(`No session with id ${id} in the database.`)
    return 1
  }
  const row = rows[0]
  const label = args[1] || store.slugify(row.title)
  const problem = store.validateLabel(label)
  if (problem) {
    info(`Invalid name: ${problem}`)
    return 1
  }
  info(`Exporting ${row.title || row.id} (${row.messages} msgs) …`)
  const entry = await store.saveSession({
    id: row.id,
    label,
    title: row.title,
    directory: row.directory,
    messages: row.messages,
  })
  info(`Saved "${entry.label}" → ${entry.file} (${formatBytes(entry.bytes)})`)
  return 0
}

async function importByLabel(args) {
  const wanted = (args[0] || "").toLowerCase()
  if (!wanted) {
    info("usage: rewind history import <name|sessionID> [folder]")
    return 1
  }
  const index = await store.readIndex()
  const entry =
    index.sessions.find((item) => item.sessionID === args[0]) ||
    index.sessions.find((item) => item.label.toLowerCase() === wanted)
  if (!entry) {
    info(`No saved session named "${args[0]}". Try: rewind history list`)
    return 1
  }
  const directory = path.resolve(args[1] || entry.directory || fallbackDir())
  const result = await store.importArchive(entry, directory)
  info(result || "imported")
  info(`Resume it with: opencode -s ${entry.sessionID}`)
  return 0
}

async function setupFlow(args) {
  const config = await readConfig()
  const wanted = args[0]
  if (wanted === undefined && !process.stdin.isTTY) {
    info("usage: rewind setup [folder]   (or REWIND_VAULT=<folder>)")
    info(`No vault configured yet. Default would be ${defaultVault()}`)
    return 1
  }

  const suggestion = wanted ? String(wanted) : configuredVault(config) || defaultVault()
  const answer = await promptText({
    title: "Where should rewind keep your saved sessions?",
    hint: "enter keeps this path",
    initial: suggestion,
    allowEmpty: true,
    validate: (value) => (value.trim() ? vaultProblem(value) : vaultProblem(suggestion)),
  })
  if (answer === null) return 130

  const previous = configuredVault(config)
  let vault
  try {
    vault = await prepareVault(answer.trim() || suggestion)
  } catch (error) {
    await notify(error.message)
    return 1
  }
  store.setVault(vault)
  await writeConfig({ ...config, vault })
  if (previous && path.resolve(previous) !== vault && !vaultIsEmpty(vault)) {
    info(`Your existing vault is still at ${previous} — move or delete it yourself.`)
  }
  info(`Vault → ${vault}`)
  info(`Saved ${configPath()}`)
  info(`Archives: ${store.SESSIONS_DIR}`)
  info(`Snapshots: ${store.DB_DIR}`)
  await notify("Done.")
  return 0
}

async function whereFlow() {
  const config = await readConfig()
  const state = describe(config)
  info(`config  ${state.configPath}${state.configured ? "" : "   (not written yet)"}`)
  info(`vault   ${state.vault}${state.configured ? "" : "   (default — run `rewind setup` to change it)"}`)
  if (state.exists) {
    store.setVault(state.vault)
    const stats = await store.vaultStats()
    info(`        exists · ${stats.sessions} archived · ${formatBytes(stats.bytes)} · ${stats.snapshots} snapshot${stats.snapshots === 1 ? "" : "s"}`)
  } else {
    info("        not created yet")
  }
  return 0
}

async function doctorFlow() {
  const config = await readConfig()
  const state = describe(config)
  const version = await store.opencodeVersion()
  const db = await store.dbFile().catch(() => "")
  const status = await plugin.pluginStatus()

  info(`node           ${process.version}`)
  info(`opencode       ${version ? `${store.opencodeBin()} (${version})` : `not found — npm install -g opencode-ai`}`)
  info(`database       ${db || store.guessDbFile() || "not found — run opencode once"}`)
  info(`config         ${state.configPath}`)
  info(`vault          ${state.vault}${state.exists ? "" : "   (will be created on first run)"}`)
  if (state.exists) {
    store.setVault(state.vault)
    const stats = await store.vaultStats()
    info(`               ${stats.sessions} archived · ${formatBytes(stats.bytes)} · ${stats.snapshots} snapshot${stats.snapshots === 1 ? "" : "s"}`)
  }

  const problems = []
  if (!version) problems.push("opencode is not on PATH")
  if (!db) problems.push("opencode's session database was not found")
  if (version && !db) problems.push("opencode runs but cannot reach its database")
  if (status.installed && !status.current) {
    problems.push(`the live saving plugin is stale — run rewind plugin install`)
  }

  info("")
  info(
    status.installed && status.current
      ? `live saving   on — saved the moment a turn ends`
      : status.installed
        ? `live saving   stale — run rewind plugin install`
        : `live saving   timer only (every ${Math.round(store.LIVE_ARCHIVE_INTERVAL / 1000)}s) — run rewind plugin install to save on every turn`,
  )

  if (!version || !db) {
    info("")
    info("Install opencode first, then rewind:")
    info("  npm install -g opencode-ai")
    return 1
  }
  for (const problem of problems) info(`! ${problem}`)
  return problems.length ? 1 : 0
}

async function pluginFlow(args) {
  const action = args[0] || "status"
  const status = await plugin.pluginStatus()

  if (action === "install") {
    const done = await plugin.installPlugin()
    info("")
    info(`Installed ${done.file}`)
    info("opencode loads it automatically at startup. Restart opencode to pick it up.")
    info("Until then the two-minute timer is still doing the saving.")
    return 0
  }

  if (action === "uninstall" || action === "remove") {
    const done = await plugin.uninstallPlugin()
    info("")
    info(done.removed ? `Removed ${done.file}` : `Nothing installed at ${done.file}`)
    info("Live saving now falls back to the timer in the rewind launcher.")
    return 0
  }

  if (action === "status") {
    info("")
    if (!status.installed) {
      info("Live saving plugin   not installed")
      info("Install it with:      rewind plugin install")
    } else if (!status.current) {
      info(`Live saving plugin   installed but stale — it points at ${status.worker}`)
      info("Refresh it with:      rewind plugin install")
    } else {
      info("Live saving plugin   installed")
      info(`  plugin  ${status.file}`)
      info(`  worker  ${status.worker}`)
      info(`  node    ${status.node}`)
    }
    return 0
  }

  info(`Unknown action "${action}". Try: rewind plugin install | uninstall | status`)
  return 1
}

async function menu() {
  if (!process.stdin.isTTY) {
    info("The session menu needs an interactive terminal.")
    info("Non-interactive options:")
    info("  rewind history list")
    info("  rewind history save <sessionID> [name]")
    info("  rewind history import <name|sessionID> [folder]")
    info("  rewind history backup-db")
    info("")
    info("Everything after `rewind` that is not `history` is passed to opencode.")
    return 1
  }

  const setup = await ensureVault()
  if (setup.vault === undefined) return launchAndArchive(() => store.launchTui({}), "")

  // Catches anything opencode recorded outside this window, so the vault is
  // never more than one run behind.
  //
  // In the background, and deliberately not awaited. The first run against a
  // database that already holds hundreds of sessions has all of them to export,
  // and one export is seconds for a long session -- enough that awaiting it
  // before the first paint leaves `rewind` looking like it failed to start. The
  // catch-up is silent because anything printed here would land on top of the
  // menu; the summary is printed by launchAndArchive when a real session ends,
  // and the timer picks up whatever is left.
  let catchingUp = false
  const startCatchUp = () => {
    if (catchingUp) return
    catchingUp = true
    store
      .archiveNewSessions()
      .catch(() => {})
      .finally(() => {
        catchingUp = false
      })
  }

  for (;;) {
    startCatchUp()

    const stats = await store.vaultStats()
    const result = await dialog({
      title: "Rewind",
      banner: "REWIND",
      byline: BYLINE,
      clear: true,
      subheading: `${stats.sessions} saved · ${formatBytes(stats.bytes)}${catchingUp ? " · saving…" : ""}`,
      filter: false,
      groups: [
        {
          label: "",
          items: [
            {
              value: "load",
              title: "Load a session",
              footer: stats.sessions ? `${stats.sessions} saved` : "nothing saved yet",
            },
            {
              value: "backup",
              title: "Back up session database",
              footer: stats.snapshots ? `${stats.snapshots} taken` : "none yet",
            },
            {
              value: "clear",
              title: "Clear all history",
              footer: "sessions and archives",
            },
            {
              value: "plain",
              title: "Start opencode",
              footer: process.cwd(),
            },
          ],
        },
      ],
      hints: [{ key: "enter", label: "select" }, { key: "esc", label: "start opencode" }],
    })

    const action = result.action === "select" ? result.value : "plain"
    if (action === "load") {
      const code = await loadFlow()
      if (typeof code === "number") return code
      continue
    }
    if (action === "clear") {
      await clearFlow()
      continue
    }
    if (action === "backup") {
      await backupFlow()
      continue
    }
    return launchAndArchive(() => store.launchTui({}), "")
  }
}

export async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) return menu()

  const [maybeSubcommand, ...rest] = argv
  if (maybeSubcommand !== SUBCOMMAND) {
    if (maybeSubcommand === "setup" || maybeSubcommand === "init") {
      await ensureVault({ interactive: false })
      return setupFlow(rest)
    }
    if (maybeSubcommand === "where") {
      await ensureVault({ interactive: false })
      return whereFlow()
    }
    if (maybeSubcommand === "doctor" || maybeSubcommand === "check") {
      await ensureVault({ interactive: false })
      return doctorFlow()
    }
    if (maybeSubcommand === "plugin" || maybeSubcommand === "live") {
      return pluginFlow(rest)
    }
    return launchAndArchive(() => store.passthrough(argv), "")
  }

  const [action, ...args] = rest
  const bootstraps = action === undefined || action === "setup" || action === "init" || action === "doctor"
  if (!bootstraps) await ensureVault({ interactive: Boolean(process.stdin.isTTY) })
  switch (action) {
    case undefined:
      return menu()
    case "list":
      return listFlow()
    case "save":
      return saveById(args)
    case "import":
      return importByLabel(args)
    case "backup-db":
      return backupFlow()
    case "clear": {
      const cancel = args.indexOf("--cancel-watcher")
      if (cancel >= 0) return cancelWatcher(args[cancel + 1])
      return clearFlow({
        yes: args.includes("--yes"),
        whenClosed: args.includes("--when-closed"),
        wait: args.includes("--wait"),
      })
    }
    case "where":
      await ensureVault({ interactive: false })
      return whereFlow()
    case "setup":
    case "init":
      return setupFlow(args)
    case "doctor":
      return doctorFlow()
    default:
      info(`Unknown action "${action}". Try: rewind history list | save | import | backup-db | clear | where | setup | doctor`)
      return 1
  }
}