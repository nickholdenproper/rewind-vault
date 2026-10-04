import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { pipeline } from "node:stream/promises"

export const CLEAR = "\u001b[2J\u001b[H\u001b[3J"

const INDEX_VERSION = 1
const LABEL_MAX = 60
const ILLEGAL_LABEL = /[<>:"/\\|?*\u0000-\u001f]/

export let VAULT = path.join(os.homedir(), ".rewind")
export let SESSIONS_DIR = path.join(VAULT, "sessions")
export let DB_DIR = path.join(VAULT, "db")
export let INDEX_PATH = path.join(VAULT, "index.json")

export function setVault(dir) {
  VAULT = path.resolve(dir)
  SESSIONS_DIR = path.join(VAULT, "sessions")
  DB_DIR = path.join(VAULT, "db")
  INDEX_PATH = path.join(VAULT, "index.json")
  return VAULT
}

let cachedBin

export function opencodeBin() {
  if (cachedBin) return cachedBin
  const shim = process.platform === "win32" ? "opencode.cmd" : "opencode"
  const candidates = [
    process.env.OPENCODE_BIN,
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    path.join(os.homedir(), ".opencode", "bin", "opencode.exe"),
    shim,
  ].filter(Boolean)
  cachedBin = candidates.find((candidate) => candidate === shim || fs.existsSync(candidate)) || shim
  return cachedBin
}

function shellQuote(value) {
  const text = String(value)
  return /[\s&|<>^()%!,;"']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function runOpencode(args, opts = {}) {
  const bin = opencodeBin()
  if (/\.(cmd|bat)$/i.test(bin)) {
    return spawn([bin, ...args].map(shellQuote).join(" "), { windowsHide: true, shell: true, ...opts })
  }
  // A .mjs/.js target has no shebang on Windows, so run it through node. This is
  // how the tests point OPENCODE_BIN at a stand-in for the real binary.
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    return spawn(process.execPath, [bin, ...args], { windowsHide: true, ...opts })
  }
  return spawn(bin, args, { windowsHide: true, ...opts })
}

export function capture(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = runOpencode(args, opts)
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve({ out, err })
      const reason = err.trim() || out.trim() || `exit code ${code}`
      reject(new Error(`opencode ${args.join(" ")} failed: ${reason}`))
    })
  })
}

export async function dbQuery(sql) {
  const { out } = await capture(["db", sql, "--format", "json"])
  const trimmed = out.trim()
  if (!trimmed) return []
  return JSON.parse(trimmed)
}

export async function dbFile() {
  const { out } = await capture(["db", "path"])
  return out.trim()
}

export function guessDbFile() {
  const candidates = [
    process.env.OPENCODE_DB && path.dirname(process.env.OPENCODE_DB),
    process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"),
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "opencode", "opencode.db"),
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate))
}

export async function opencodeVersion() {
  try {
    const { out, err } = await capture(["--version"])
    const line = `${out}\n${err}`.split(/\r?\n/).map((item) => item.trim()).find((item) => /^\d+\.\d+/.test(item))
    return line || "installed"
  } catch {
    return undefined
  }
}

export async function exportSessionTo(id, destGz) {
  await fsp.mkdir(path.dirname(destGz), { recursive: true })
  const child = runOpencode(["export", id])
  // Subscribe before awaiting the pipeline. A child that writes nothing exits
  // before the pipe drains, so `close` can fire while the pipeline is still
  // settling; a listener attached afterwards would wait for an event that has
  // already happened and never resolve.
  const closed = new Promise((resolve) => child.once("close", resolve))
  try {
    await pipeline(child.stdout, zlib.createGzip({ level: 9 }), fs.createWriteStream(destGz))
  } catch (error) {
    child.kill()
    await fsp.rm(destGz, { force: true })
    throw new Error(`opencode export ${id} failed: ${error.message}`)
  }
  const code = await closed
  if (code !== 0) {
    await fsp.rm(destGz, { force: true })
    throw new Error(`opencode export ${id} exited with code ${code}`)
  }
  return destGz
}

export function entryFile(entry) {
  return path.isAbsolute(entry.file) ? entry.file : path.join(VAULT, ...entry.file.split("/"))
}

export async function importArchive(entry, cwd) {
  const source = entryFile(entry)
  if (!fs.existsSync(source)) throw new Error(`archive missing: ${source}`)
  const tmp = path.join(os.tmpdir(), `opencode-restore-${entry.sessionID}-${Date.now()}.json`)
  await pipeline(fs.createReadStream(source), zlib.createGunzip(), fs.createWriteStream(tmp))
  try {
    const { out } = await capture(["import", tmp], { cwd })
    return out.trim()
  } finally {
    await fsp.rm(tmp, { force: true })
  }
}

export async function readIndex() {
  try {
    const data = JSON.parse(await fsp.readFile(INDEX_PATH, "utf8"))
    if (Array.isArray(data?.sessions)) {
      return { version: INDEX_VERSION, sessions: data.sessions }
    }
  } catch {}
  return { version: INDEX_VERSION, sessions: [] }
}

async function writeIndex(index) {
  index.version = INDEX_VERSION
  index.sessions = [...index.sessions].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
  await fsp.mkdir(VAULT, { recursive: true })
  const tmp = `${INDEX_PATH}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`)
  await fsp.rename(tmp, INDEX_PATH)
}

export async function upsertSession(entry) {
  const index = await readIndex()
  index.sessions = [...index.sessions.filter((item) => item.sessionID !== entry.sessionID), entry]
  await writeIndex(index)
  return entry
}

export function autoLabel(row) {
  const title = String(row?.title ?? "").trim()
  return `${slugify(title || "session")}-${String(row?.id ?? "").slice(-4)}`
}

/**
 * Picks the rows worth archiving.
 *
 * Every top-level session qualifies. There is no folder to register and no
 * project to match -- a session is worth keeping because it happened, and the
 * only question is whether the vault already holds a current copy.
 *
 * A session already in the vault is re-archived when opencode has touched it
 * since that copy was taken, so an archive tracks the live session instead of
 * freezing at whatever it looked like the first time. The limit only counts
 * first-time saves, otherwise routine refreshes would eat the quota and starve
 * genuinely new sessions.
 */
export function planAutoArchive(rows, seen = [], limit = ARCHIVE_LIMIT, refresh = 0) {
  const have = new Map(
    seen.map((item) => [typeof item === "string" ? item : item.sessionID, typeof item === "string" ? null : item]),
  )
  let budget = Math.max(0, Number(limit) || 0)
  const plan = []
  for (const row of rows || []) {
    if (!row || !row.id) continue

    const previous = have.get(row.id)
    if (have.has(row.id)) {
      const savedAt = previous ? Number(previous.savedAt || 0) : 0
      const stale = Number(row.timeUpdated || 0) > savedAt + refresh
      if (!stale) continue
    } else {
      if (budget <= 0) continue
      budget -= 1
    }

    have.set(row.id, { sessionID: row.id, savedAt: Date.now() })
    // Reuse the existing label so a refresh overwrites the same file. Deriving a
    // fresh one from a retitled session would leave the old archive behind.
    const label = previous && previous.label ? previous.label : autoLabel(row)
    plan.push({ row, label, refresh: Boolean(previous) })
  }
  return plan
}

/**
 * How many of the most recently touched sessions to consider. Recent first is
 * the right order because a run only ever keeps a handful anyway.
 */
export const ARCHIVE_SCAN = 500

/** New sessions archived per pass, so a huge backlog cannot fill the disk at once. */
export const ARCHIVE_LIMIT = 25

function envMs(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * How often the vault is brought up to date while opencode is running, and how
 * long an archive has to sit still before it is worth rewriting.
 *
 * The first number bounds how much work a hard power-off can cost you. The
 * second keeps a session that is actively being written from being re-exported
 * on every single pass, which for a long session is an expensive gzip.
 */
export const LIVE_ARCHIVE_INTERVAL = envMs("REWIND_LIVE_INTERVAL", 120_000)
export const LIVE_ARCHIVE_REFRESH = envMs("REWIND_LIVE_REFRESH", 300_000)

export async function autoArchive({ limit = ARCHIVE_LIMIT, scan = ARCHIVE_SCAN, refresh = 0 } = {}) {
  const index = await readIndex()

  const rows = await dbQuery(
    `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS timeUpdated,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s
     WHERE s.parent_id IS NULL AND s.time_archived IS NULL
     ORDER BY s.time_updated DESC
     LIMIT ${Math.max(1, Number(scan) || ARCHIVE_SCAN)}`,
  )

  const plan = planAutoArchive(rows, index.sessions, limit, refresh)
  const saved = []
  const refreshed = []
  for (const item of plan) {
    const entry = await saveSession({
      id: item.row.id,
      label: item.label,
      title: item.row.title,
      directory: item.row.directory,
      messages: item.row.messages,
    })
    ;(item.refresh ? refreshed : saved).push(entry)
  }
  return { saved, refreshed }
}

const SESSION_PROJECTION = `s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS timeUpdated,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages`

/** Escapes a value for use as a single-quoted SQL string literal. */
function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Archives one specific session.
 *
 * This is what the opencode plugin calls from `session.idle`. It deliberately
 * reuses planAutoArchive so a plugin-triggered save and a timer-triggered save
 * make exactly the same decisions about labels and refreshes.
 *
 * Returns the archive entry, or null when there was nothing to do: no id, an
 * unknown session, or an archive that is already current.
 */
export async function archiveSessionById(id, { refresh = 0 } = {}) {
  const sessionID = String(id ?? "").trim()
  if (!sessionID) return null

  const index = await readIndex()

  const rows = await dbQuery(
    `SELECT ${SESSION_PROJECTION} FROM session s
     WHERE s.id = ${sqlText(sessionID)} AND s.parent_id IS NULL AND s.time_archived IS NULL
     LIMIT 1`,
  )
  const row = rows[0]
  if (!row) return null

  const plan = planAutoArchive([row], index.sessions, 1, refresh)
  if (plan.length === 0) return null

  const item = plan[0]
  return saveSession({
    id: item.row.id,
    label: item.label,
    title: item.row.title,
    directory: item.row.directory,
    messages: item.row.messages,
  })
}

/**
 * Runs `autoArchive` without ever throwing, so a database that cannot be read
 * degrades to "nothing new saved" instead of taking the menu down with it. The
 * reason comes back in `error` because a silent no-op is indistinguishable from
 * "you have nothing new" -- which is exactly the bug this replaces.
 */
export async function archiveNewSessions(options = {}) {
  try {
    return await autoArchive(options)
  } catch (error) {
    return { saved: [], refreshed: [], error }
  }
}

/**
 * Keeps the vault current while opencode is running, so a hard power-off or a
 * killed process costs at most one interval of work instead of the whole
 * session.
 *
 * Nothing is printed from here: this runs while opencode owns the terminal, so
 * writing to stdout would scribble over its TUI. Errors are handed to `onError`
 * and the caller decides when it is safe to speak. Returns a stop function.
 */
export function startLiveArchive({ intervalMs = LIVE_ARCHIVE_INTERVAL, refresh = LIVE_ARCHIVE_REFRESH, onError } = {}) {
  const timer = setInterval(() => {
    autoArchive({ refresh }).catch((error) => {
      if (onError) onError(error)
    })
  }, Math.max(1000, Number(intervalMs) || LIVE_ARCHIVE_INTERVAL))
  // Never hold the process open on our own account.
  if (typeof timer.unref === "function") timer.unref()
  return () => clearInterval(timer)
}

export function slugify(label) {
  const slug = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, LABEL_MAX) || "session"
}

export function validateLabel(value) {
  const label = String(value ?? "").trim()
  if (!label) return "a name is required"
  if (label.length > LABEL_MAX) return `keep it under ${LABEL_MAX} characters`
  if (ILLEGAL_LABEL.test(label)) return 'use letters, digits, spaces, . - _ only (no : / \\ | ? * " < >)'
  return undefined
}

export async function saveSession({ id, label, title, directory, messages }) {
  const rel = path.posix.join("sessions", `${slugify(label)}--${id}.json.gz`)
  const dest = path.join(VAULT, ...rel.split("/"))
  await exportSessionTo(id, dest)
  const stat = await fsp.stat(dest)
  return upsertSession({
    label: String(label).trim(),
    sessionID: id,
    title: title || "",
    directory: directory || "",
    file: rel,
    savedAt: Date.now(),
    messages: Number(messages) || 0,
    bytes: stat.size,
  })
}

export async function backupDatabase() {
  await fsp.mkdir(DB_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 12)
  const dest = path.join(DB_DIR, `opencode-${stamp}.db`)
  const sql = `VACUUM INTO '${dest.replace(/\\/g, "/")}'`
  await capture(["db", sql])
  const stat = await fsp.stat(dest)
  return { file: dest, bytes: stat.size }
}

export function launchTui({ directory, sessionID } = {}) {
  const args = []
  if (sessionID) args.push("-s", sessionID)
  if (directory) args.push(directory)
  if (process.env.OC_DRY_RUN) {
    const bin = opencodeBin()
    process.stdout.write(`[dry-run] ${bin} ${args.join(" ")}\n`)
    return Promise.resolve(0)
  }
  process.on("SIGINT", () => {})
  process.on("SIGTERM", () => {})
  return new Promise((resolve) => {
    process.stdout.write(CLEAR)
    const child = runOpencode(args, { cwd: directory || process.cwd(), stdio: "inherit" })
    child.on("error", (error) => {
      process.stderr.write(`failed to launch opencode: ${error.message}\n`)
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 0))
  })
}

export function passthrough(args) {
  return new Promise((resolve) => {
    const child = runOpencode(args, { cwd: process.cwd(), stdio: "inherit" })
    child.on("error", (error) => {
      process.stderr.write(`failed to launch opencode: ${error.message}\n`)
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 0))
  })
}

export async function renameArchive(entry, label) {
  const problem = validateLabel(label)
  if (problem) throw new Error(problem)
  const trimmed = String(label).trim()
  const rel = path.posix.join("sessions", `${slugify(trimmed)}--${entry.sessionID}.json.gz`)
  const from = entryFile(entry)
  const to = path.join(VAULT, ...rel.split("/"))
  if (path.resolve(from) !== path.resolve(to)) {
    if (!fs.existsSync(from)) throw new Error(`archive missing: ${from}`)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rename(from, to)
  }
  const stat = await fsp.stat(to)
  return upsertSession({ ...entry, label: trimmed, file: rel, bytes: stat.size })
}

export async function deleteArchive(entry) {
  const source = entryFile(entry)
  await fsp.rm(source, { force: true })
  const index = await readIndex()
  index.sessions = index.sessions.filter((item) => item.sessionID !== entry.sessionID)
  await writeIndex(index)
  return entry
}

export async function vaultStats() {
  const index = await readIndex()
  const sessions = index.sessions.length
  const bytes = index.sessions.reduce((total, item) => total + (Number(item.bytes) || 0), 0)
  let snapshots = 0
  let snapshotBytes = 0
  try {
    for (const item of await fsp.readdir(DB_DIR)) {
      if (!item.endsWith(".db")) continue
      snapshots++
      snapshotBytes += (await fsp.stat(path.join(DB_DIR, item))).size
    }
  } catch {}
  return { sessions, bytes, snapshots, snapshotBytes }
}

/** Runs one statement through opencode's sqlite shell. */
async function dbExec(sql) {
  await capture(["db", sql])
}

/**
 * Whether an opencode process is alive right now.
 *
 * Clearing history underneath a running opencode is a good way to corrupt it: it
 * holds sessions in memory and would happily write them straight back over the
 * top. Probing is best effort -- if the platform tool is missing we say "maybe"
 * rather than block the user on a guess.
 */
export async function opencodeRunning() {
  // An override, because the probe below is a heuristic and heuristics are wrong
  // on some setups. `1` forces the guard on, `0` forces it off. The tests need it
  // to reach the branch at all, and it is the escape hatch if opencode is running
  // under a name this does not recognise.
  const forced = process.env.REWIND_ASSUME_OPENCODE_RUNNING
  if (forced !== undefined) return forced !== "0"

  const probes = {
    win32: ["tasklist", "/FI", "IMAGENAME eq opencode.exe", "/NH"],
    darwin: ["pgrep", "-x", "opencode"],
    linux: ["pgrep", "-x", "opencode"],
  }
  const args = probes[process.platform]
  if (!args) return null
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(args[0], args.slice(1), { windowsHide: true, shell: false })
    } catch {
      resolve(null)
      return
    }
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", () => resolve(null))
    child.on("close", (code) => resolve(code === 0 ? /opencode/i.test(out) : false))
  })
}

/** How much session history opencode is currently holding. */
export async function historyCounts() {
  const rows = await dbQuery(
    `SELECT (SELECT COUNT(*) FROM session) AS sessions,
            (SELECT COUNT(*) FROM message) AS messages,
            (SELECT COUNT(*) FROM part) AS parts,
            (SELECT COUNT(*) FROM todo) AS todos,
            (SELECT COUNT(*) FROM event) AS events`,
  )
  return rows[0] || { sessions: 0, messages: 0, parts: 0, todos: 0, events: 0 }
}

/**
 * Deletes every session opencode has ever recorded.
 *
 * `session` cascades to message, part, todo and the session_* tables, and
 * `event_sequence` cascades to `event` -- the event-sourced log, which is by far
 * the biggest table and holds a full copy of each session. Projects, workspaces
 * and credentials are deliberately left alone: those are configuration, not
 * history.
 *
 * opencode's shell runs one statement per invocation and ignores anything after
 * a semicolon, so each of these is a separate call. Cascades rely on
 * `foreign_keys`, which that connection already has on.
 *
 * Deleting rows does not shrink the file, so the tail reclaims the space: in WAL
 * mode VACUUM writes into the write-ahead log and the main file only gives the
 * pages back after a checkpoint. Skipping this left a 2.4 GB file holding
 * nothing.
 */
export async function clearOpencodeHistory() {
  const before = await historyCounts()
  await dbExec("DELETE FROM event_sequence")
  await dbExec("DELETE FROM session")
  await dbExec("PRAGMA wal_checkpoint(TRUNCATE)")
  await dbExec("VACUUM")
  await dbExec("PRAGMA wal_checkpoint(TRUNCATE)")
  return before
}

/** Empties the vault: every archive and every database snapshot. */
export async function clearVault() {
  const index = await readIndex()
  const removed = index.sessions.length
  await fsp.rm(SESSIONS_DIR, { recursive: true, force: true })
  await fsp.rm(DB_DIR, { recursive: true, force: true })
  await fsp.mkdir(VAULT, { recursive: true })
  await writeIndex({ version: INDEX_VERSION, sessions: [] })
  return { removed }
}
