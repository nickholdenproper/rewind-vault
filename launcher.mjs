#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import {
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
const RECENT_LIMIT = 15

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
  return { vault, asked: true, remembered: config.lastProject?.folder }
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
 * Auto-archived sessions carry the project they belong to, so they group under
 * it. Anything saved by hand has no project, and falls back to the day it was
 * archived, which is how the load screen has always grouped them.
 */
function savedGroups(entries) {
  return groupBy(entries, (entry) => entry.project || dayGroup(entry.savedAt)).map((group) => ({
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

async function newProjectFlow() {
  const config = await readConfig()
  const remembered = config.lastProject?.folder
  const suggestion = remembered ? path.basename(path.resolve(remembered)) : ""

  const name = await promptText({
    title: "Name this project:",
    hint: "letters, digits, spaces, . - _ only",
    initial: suggestion,
    validate: store.validateLabel,
  })
  if (name === null) return null

  const folder = await promptText({
    title: `Where does "${name.trim()}" live?`,
    hint: remembered ? "enter keeps this folder" : "a folder for this project",
    initial: remembered || fallbackDir(),
    validate: (value) => {
      const trimmed = value.trim()
      if (!trimmed) return "a folder is required"
      return vaultProblem(trimmed) || undefined
    },
  })
  if (folder === null) return null

  const resolved = path.resolve(folder.trim())
  const project = await withSpinner(`Preparing ${name.trim()}`, async () => {
    const directory = await store.ensureProjectFolder(resolved)
    return store.upsertProject({ name: name.trim(), folder: directory })
  })
  await writeConfig({ ...config, lastProject: { name: project.name, folder: project.folder } })
  info(`${project.name} → ${project.folder}`)
  // launchTui clears the screen, so the confirmation has to come after it exits.
  return launchAndArchive(() => store.launchTui({ directory: project.folder }), project.name, `Watching ${project.name} — sessions save every ${Math.round(store.LIVE_ARCHIVE_INTERVAL / 1000)}s while you work, and again on exit.`)
}

async function saveFlow() {
  const index = await store.readIndex()
  const already = new Map(index.sessions.map((entry) => [entry.sessionID, entry.label]))
  const rows = await store.recentSessions(RECENT_LIMIT)
  if (rows.length === 0) {
    await notify("No sessions found in the opencode database.")
    return
  }

  const groups = groupBy(rows, (row) => dayGroup(row.timeUpdated)).map((group) => ({
    label: group.label,
    items: group.items.map((row) => ({
      value: row,
      title: row.title || row.id,
      footer: `${folderName(row.directory)} · ${row.messages || 0} msgs`,
      preview: `${relativeTime(row.timeUpdated)} · ${row.directory || "unknown dir"}${already.has(row.id) ? ` · already saved as "${already.get(row.id)}"` : ""}`,
    })),
  }))

  const result = await dialog({
    title: "Save a session",
    byline: "",
    subheading: `${RECENT_LIMIT} most recent · ${already.size} already in the vault`,
    groups,
    empty: "No sessions found in the opencode database.",
    hints: [{ key: "enter", label: "archive" }],
  })
  if (result.action !== "select") return
  const picked = result.value

  const suggestion = already.get(picked.id) || store.slugify(picked.title)
  const label = await promptText({
    title: "Name this session so you recognise it later:",
    hint: "letters, digits, spaces, . - _ only",
    initial: suggestion,
    validate: store.validateLabel,
  })
  if (label === null) return

  const entry = await withSpinner(`Exporting ${picked.title || picked.id}`, () =>
    store.saveSession({
      id: picked.id,
      label,
      title: picked.title,
      directory: picked.directory,
      messages: picked.messages,
    }),
  )
  info(`Saved "${entry.label}" → ${entry.file} (${formatBytes(entry.bytes)}, ${entry.messages} msgs)`)
  await notify("Done.")
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

  for (;;) {
    // Catches anything opencode recorded outside this window, so the vault is
    // never more than one run behind.
    await archiveNew()

    const stats = await store.vaultStats()
    const result = await dialog({
      title: "Rewind",
      banner: "REWIND",
      byline: BYLINE,
      clear: true,
      subheading: `${stats.sessions} archived · ${formatBytes(stats.bytes)}${stats.projects ? ` · ${stats.projects} project${stats.projects === 1 ? "" : "s"}` : ""}${stats.snapshots ? ` · ${stats.snapshots} snapshot${stats.snapshots === 1 ? "" : "s"}` : ""}`,
      filter: false,
      groups: [
        {
          label: "",
          items: [
            {
              value: "load",
              title: "Load a session",
              footer: stats.sessions ? `${stats.sessions} saved` : "nothing saved yet",
              preview: stats.sessions ? `archives live in ${store.SESSIONS_DIR}` : "save a session to build the vault",
            },
            {
              value: "new",
              title: "Start new project",
              footer: setup.remembered ? "last folder remembered" : "name it and pick a folder",
              preview: setup.remembered
                ? `enter to reuse ${setup.remembered}`
                : "sessions from this folder archive themselves when you quit opencode",
            },
            {
              value: "save",
              title: "Save a session",
              footer: "archive recent sessions",
              preview: "exports recent sessions from the opencode database",
            },
            {
              value: "backup",
              title: "Back up session database",
              footer: "vacuumed snapshot",
              preview: `writes opencode-<timestamp>.db into ${store.DB_DIR}`,
            },
            {
              value: "plain",
              title: "Start opencode without a session",
              footer: "default",
              preview: `plain opencode in ${process.cwd()}`,
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
    if (action === "new") {
      const code = await newProjectFlow()
      if (typeof code === "number") return code
      continue
    }
    if (action === "save") {
      await saveFlow()
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
    case "where":
      await ensureVault({ interactive: false })
      return whereFlow()
    case "setup":
    case "init":
      return setupFlow(args)
    case "doctor":
      return doctorFlow()
    default:
      info(`Unknown action "${action}". Try: rewind history list | save | import | backup-db | where | setup | doctor`)
      return 1
  }
}