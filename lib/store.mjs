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
  try {
    await pipeline(child.stdout, zlib.createGzip({ level: 9 }), fs.createWriteStream(destGz))
  } catch (error) {
    child.kill()
    await fsp.rm(destGz, { force: true })
    throw new Error(`opencode export ${id} failed: ${error.message}`)
  }
  const code = await new Promise((resolve) => child.on("close", resolve))
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
    if (Array.isArray(data?.sessions)) return { version: INDEX_VERSION, sessions: data.sessions }
  } catch {}
  return { version: INDEX_VERSION, sessions: [] }
}

async function writeIndex(index) {
  index.version = INDEX_VERSION
  index.sessions = [...index.sessions].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
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
