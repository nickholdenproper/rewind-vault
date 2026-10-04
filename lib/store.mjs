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

export async function recentSessions(limit = 15) {
  return dbQuery(
    `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS timeUpdated,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s
     WHERE s.parent_id IS NULL AND s.time_archived IS NULL
     ORDER BY s.time_updated DESC
     LIMIT ${Number(limit) || 15}`,
  )
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
      return {
        version: INDEX_VERSION,
        sessions: data.sessions,
        projects: Array.isArray(data.projects) ? data.projects : [],
      }
    }
  } catch {}
  return { version: INDEX_VERSION, sessions: [], projects: [] }
}

async function writeIndex(index) {
  index.version = INDEX_VERSION
  index.sessions = [...index.sessions].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
  index.projects = [...(index.projects || [])].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
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

/**
 * Folds a project folder down to one comparable key.
 *
 * Every directory comparison has to go through here. opencode stores
 * `session.directory` with forward slashes (`C:/code/app`), while config files
 * and the project prompt hand us whatever the platform produced, which on
 * Windows means backslashes (`C:\code\app`). SQLite compares those two byte for
 * byte, so pushing the comparison into SQL -- an `s.directory IN (...)` list is
 * the tempting way to do it -- silently matches nothing and no session is ever
 * auto-archived. Matching in JavaScript against this key is separator- and
 * case-insensitive on the platforms that are.
 */
export function folderKey(dir) {
  const resolved = path.resolve(String(dir ?? ""))
  const slashed = process.platform === "win32" ? resolved.replace(/\//g, "\\") : resolved
  const trimmed = slashed.replace(/[\\/]+$/, "") || slashed
  return process.platform === "win32" || process.platform === "darwin" ? trimmed.toLowerCase() : trimmed
}

export function projectId(name) {
  return slugify(name)
}

export async function upsertProject(project) {
  const index = await readIndex()
  const name = String(project.name).trim()
  const folder = path.resolve(project.folder)
  const id = projectId(name)
  const key = folderKey(folder)

  // The folder is the identity, not the name. Matching on the name alone let a
  // single folder accumulate aliases -- registering "New folder" three times
  // produced three projects -- and then planAutoArchive had to pick a winner,
  // so whichever lost looked permanently empty while its sessions turned up
  // somewhere else. Re-registering a folder now renames the one project that
  // already owns it.
  const byFolder = index.projects.find((item) => folderKey(item.folder) === key)
  const previous = byFolder || index.projects.find((item) => item.id === id)

  const next = {
    id,
    name,
    folder,
    createdAt: previous?.createdAt || project.createdAt || Date.now(),
    lastUsed: Date.now(),
  }

  // Every name this folder has ever been registered under, so a vault carrying
  // aliases from an older version heals completely in one go.
  const aliases = new Set(index.projects.filter((item) => folderKey(item.folder) === key).map((item) => item.name))
  if (previous) aliases.add(previous.name)

  index.projects = index.projects.filter((item) => item.id !== previous?.id && folderKey(item.folder) !== key)
  index.projects = [...index.projects, next]

  // Archived sessions record the project by name, so a rename has to carry them
  // across or the load screen keeps showing the old name for existing work.
  if (aliases.size) {
    index.sessions = index.sessions.map((item) =>
      item.project !== name && aliases.has(item.project) ? { ...item, project: name } : item,
    )
  }

  await writeIndex(index)
  return next
}

/** Folders that more than one project claims, with the names involved. */
export function duplicateFolders(projects) {
  const byKey = new Map()
  for (const item of projects) {
    const key = folderKey(item.folder)
    byKey.set(key, [...(byKey.get(key) || []), item.name])
  }
  return [...byKey.values()].filter((names) => names.length > 1)
}

export function autoLabel(project, row) {
  const title = String(row.title ?? "").trim()
  const base = slugify(title || String(project?.name ?? "").trim() || "session")
  return `${base}-${String(row.id).slice(-4)}`
}

export async function ensureProjectFolder(dir) {
  const folder = path.resolve(dir)
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

/**
 * Picks the rows worth archiving: top-level sessions whose directory belongs to
 /**
 * Picks the rows worth archiving.
 *
 * A session that is already in the vault is re-archived when opencode has
 * touched it since the archived copy was taken, so an archive tracks the live
 * session instead of freezing at whatever it looked like the first time. The
 * per-project budget only counts first-time saves, otherwise routine refreshes
 * would eat the quota and starve genuinely new sessions.
 */
export function planAutoArchive(projects, rows, seen = [], perProject = 10, refresh = 0) {
  const byFolder = new Map()
  for (const item of projects) {
    const key = folderKey(item.folder)
    const held = byFolder.get(key)
    // upsertProject keeps one project per folder, but an index written by an
    // older version can still hold aliases. Pick the most recently used one
    // instead of letting array order decide silently, which is what made a
    // freshly added project look empty.
    if (!held || Number(item.lastUsed || 0) > Number(held.lastUsed || 0)) byFolder.set(key, item)
  }
  const have = new Map(
    seen.map((item) => [typeof item === "string" ? item : item.sessionID, typeof item === "string" ? null : item]),
  )
  const budget = new Map([...byFolder.keys()].map((folder) => [folder, perProject]))
  const plan = []
  for (const row of rows) {
    if (!row.directory) continue
    const key = folderKey(row.directory)
    const project = byFolder.get(key)
    if (!project) continue

    const previous = have.get(row.id)
    if (have.has(row.id)) {
      const savedAt = previous ? Number(previous.savedAt || 0) : 0
      const stale = Number(row.timeUpdated || 0) > savedAt + refresh
      if (!stale) continue
    } else {
      const left = budget.get(key) ?? 0
      if (left <= 0) continue
      budget.set(key, left - 1)
    }

    have.set(row.id, { sessionID: row.id, savedAt: Date.now() })
    // Reuse the existing label so a refresh overwrites the same file. Deriving a
    // fresh one from a retitled session would leave the old archive behind.
    const label = previous && previous.label ? previous.label : autoLabel(project, row)
    plan.push({ row, project, label, refresh: Boolean(previous) })
  }
  return plan
}

/** Registered projects whose folder has since been moved or deleted. */
export function missingFolders(projects) {
  return projects.filter((item) => !fs.existsSync(item.folder)).map((item) => item.folder)
}

/**
 * How many of the most recently touched sessions to consider. Recent first is
 * the right order because a run only ever keeps a handful per project anyway.
 */
export const ARCHIVE_SCAN = 500

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

export async function autoArchive({ perProject = 10, scan = ARCHIVE_SCAN, refresh = 0 } = {}) {
  const index = await readIndex()
  if (index.projects.length === 0) return { saved: [], refreshed: [], missing: [], projects: index.projects }

  const rows = await dbQuery(
    `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS timeUpdated,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s
     WHERE s.parent_id IS NULL AND s.time_archived IS NULL
     ORDER BY s.time_updated DESC
     LIMIT ${Math.max(1, Number(scan) || ARCHIVE_SCAN)}`,
  )

  const plan = planAutoArchive(index.projects, rows, index.sessions, perProject, refresh)
  const saved = []
  const refreshed = []
  for (const item of plan) {
    const entry = await saveSession({
      id: item.row.id,
      label: item.label,
      title: item.row.title,
      directory: item.row.directory,
      messages: item.row.messages,
      project: item.project.name,
    })
    ;(item.refresh ? refreshed : saved).push(entry)
  }
  return { saved, refreshed, missing: missingFolders(index.projects), projects: index.projects }
}

const SESSION_PROJECTION = `s.id AS id, s.title AS title, s.directory AS directory, s.time_updated AS timeUpdated,
     (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages`

/** Escapes a value for use as a single-quoted SQL string literal. */
function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Archives one specific session, if its folder belongs to a registered project.
 *
 * This is what the opencode plugin calls from `session.idle`. It deliberately
 * reuses planAutoArchive so a plugin-triggered save and a timer-triggered save
 * make exactly the same decisions about matching, labels and refreshes.
 *
 * Returns the archive entry, or null when there was nothing to do -- an unknown
 * session, a folder that is not a project, or an archive that is still current.
 */
export async function archiveSessionById(id, { refresh = 0 } = {}) {
  const sessionID = String(id ?? "").trim()
  if (!sessionID) return null

  const index = await readIndex()
  if (index.projects.length === 0) return null

  const rows = await dbQuery(
    `SELECT ${SESSION_PROJECTION} FROM session s
     WHERE s.id = ${sqlText(sessionID)} AND s.parent_id IS NULL AND s.time_archived IS NULL
     LIMIT 1`,
  )
  const row = rows[0]
  if (!row || !row.directory) return null

  const plan = planAutoArchive(index.projects, [row], index.sessions, 1, refresh)
  if (plan.length === 0) return null

  const item = plan[0]
  return saveSession({
    id: item.row.id,
    label: item.label,
    title: item.row.title,
    directory: item.row.directory,
    messages: item.row.messages,
    project: item.project.name,
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
    return { saved: [], refreshed: [], missing: [], projects: [], error }
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

export async function saveSession({ id, label, title, directory, messages, project }) {
  const rel = path.posix.join("sessions", `${slugify(label)}--${id}.json.gz`)
  const dest = path.join(VAULT, ...rel.split("/"))
  await exportSessionTo(id, dest)
  const stat = await fsp.stat(dest)
  return upsertSession({
    label: String(label).trim(),
    sessionID: id,
    title: title || "",
    directory: directory || "",
    project: project || "",
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
  const projects = index.projects.length
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
  return { sessions, projects, bytes, snapshots, snapshotBytes }
}
