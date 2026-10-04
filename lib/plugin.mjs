import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { homeDir } from "./config.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, "..")

export const PLUGIN_NAME = "rewind-live.js"

/**
 * Where opencode auto-loads global plugins from. Deliberately not the same place
 * rewind keeps its own config.
 */
export function opencodePluginDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config")
  return path.join(base, "opencode", "plugins")
}

export function pluginPath() {
  return path.join(opencodePluginDir(), PLUGIN_NAME)
}

export function workerPath() {
  return path.join(PACKAGE_ROOT, "plugin", "archive-once.mjs")
}

export function templatePath() {
  return path.join(PACKAGE_ROOT, "plugin", PLUGIN_NAME)
}

function jsonString(value) {
  return JSON.stringify(String(value))
}

/**
 * Renders the plugin with this machine's node and worker paths baked in.
 *
 * process.execPath is the right node to bake in: rewind is running under it
 * right now, so it is guaranteed to exist and to match the runtime the vault
 * was written with. Resolving `node` off PATH later would be a guess.
 */
export function renderPlugin({ node = process.execPath, worker = workerPath() } = {}) {
  const template = fs.readFileSync(templatePath(), "utf8")
  return template
    .replaceAll("__REWIND_NODE__", jsonString(node))
    .replaceAll("__REWIND_WORKER__", jsonString(worker))
}

export async function pluginStatus() {
  const file = pluginPath()
  let installed = false
  let current = false
  let installedWorker
  let installedNode
  if (fs.existsSync(file)) {
    installed = true
    const text = fs.readFileSync(file, "utf8")
    installedNode = /const NODE = (".*")/.exec(text)?.[1]
    installedWorker = /const WORKER = (".*")/.exec(text)?.[1]
    try {
      installedWorker = JSON.parse(installedWorker)
      installedNode = JSON.parse(installedNode)
    } catch {}
    // An installed plugin pointing at a moved or deleted rewind would fail
    // silently on every turn, so treat it as needing reinstall.
    current =
      installedWorker === workerPath() &&
      installedNode === process.execPath &&
      fs.existsSync(workerPath()) &&
      fs.existsSync(installedWorker || "")
  }
  return { installed, current, file, worker: installedWorker, node: installedNode }
}

export async function installPlugin() {
  const file = pluginPath()
  const body = renderPlugin()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, body)
  await fsp.rename(tmp, file)
  return { file, worker: workerPath(), node: process.execPath }
}

export async function uninstallPlugin() {
  const file = pluginPath()
  if (!fs.existsSync(file)) return { removed: false, file }
  await fsp.rm(file, { force: true })
  return { removed: true, file }
}