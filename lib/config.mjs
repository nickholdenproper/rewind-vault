import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CONFIG_VERSION = 1

export function homeDir() {
  return process.env.REWIND_HOME || os.homedir()
}

export function defaultVault() {
  if (process.env.REWIND_VAULT) return expandPath(process.env.REWIND_VAULT)
  return path.join(homeDir(), ".rewind")
}

export function configDir() {
  if (process.env.REWIND_CONFIG_DIR) return path.resolve(expandPath(process.env.REWIND_CONFIG_DIR))
  const base = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config")
  return path.join(base, "rewind")
}

export function configPath() {
  return path.join(configDir(), "config.json")
}

export function expandPath(value) {
  let out = String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
  if (!out) return ""
  if (out === "~") out = homeDir()
  else if (/^~[\\/]/.test(out)) out = path.join(homeDir(), out.slice(2))
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] ?? match)
  out = out.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) => process.env[braced || bare] ?? match)
  return path.resolve(out)
}

export async function readConfig() {
  try {
    const data = JSON.parse(await fsp.readFile(configPath(), "utf8"))
    if (data && typeof data === "object") return { version: CONFIG_VERSION, ...data }
  } catch {}
  return { version: CONFIG_VERSION }
}

export async function writeConfig(config) {
  const next = { version: CONFIG_VERSION, ...config }
  delete next.version_note
  await fsp.mkdir(configDir(), { recursive: true })
  const tmp = `${configPath()}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`)
  await fsp.rename(tmp, configPath())
  try {
    await fsp.chmod(configPath(), 0o600)
  } catch {}
  return next
}

export function configuredVault(config) {
  const raw = process.env.REWIND_VAULT || config?.vault
  return raw ? expandPath(raw) : undefined
}

export function vaultProblem(value) {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return "a folder is required"
  const unresolved = [...trimmed.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)].find(
    (match) => process.env[match[1] || match[2] || match[3]] === undefined,
  )
  if (unresolved) return `${unresolved[0]} is not set on this machine`
  const resolved = expandPath(trimmed)
  if (!resolved) return "that path could not be resolved"
  if (resolved === path.parse(resolved).root) return "pick a folder inside your home directory, not a drive root"
  if (resolved === homeDir()) return "pick a folder for rewind, not your home directory itself"
  if (path.basename(resolved) === "sessions") return "point at the vault folder itself, not its sessions subfolder"
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) return "that path is a file, not a folder"
  const parent = path.dirname(resolved)
  if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) return `the parent folder is not a folder: ${parent}`
  return undefined
}

export async function prepareVault(dir) {
  const target = expandPath(dir)
  const problem = vaultProblem(target)
  if (problem) throw new Error(problem)
  try {
    await fsp.mkdir(path.join(target, "sessions"), { recursive: true })
    await fsp.mkdir(path.join(target, "db"), { recursive: true })
  } catch (error) {
    throw new Error(`could not create ${target}: ${error.message}`)
  }
  const probe = path.join(target, ".rewind-write-test")
  try {
    await fsp.writeFile(probe, "ok")
    await fsp.rm(probe, { force: true })
  } catch (error) {
    throw new Error(`that folder is not writable: ${error.message}`)
  }
  return target
}

export function vaultExists(dir) {
  const target = expandPath(dir)
  if (!target) return false
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function vaultIsEmpty(dir) {
  const target = expandPath(dir)
  try {
    return fs.readdirSync(target).filter((name) => name !== ".DS_Store").length === 0
  } catch {
    return true
  }
}

export function describe(config) {
  const vault = configuredVault(config)
  return {
    configPath: configPath(),
    configDir: configDir(),
    vault: vault || defaultVault(),
    configured: Boolean(vault),
    exists: vault ? vaultExists(vault) : false,
  }
}