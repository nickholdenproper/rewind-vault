const PALETTE = {
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  info: "#56b6c2",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
}

const ANSI16 = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
]

const ESC = "\u001b"
const CSI = /\u001b\[[0-9;]*m/g
const ZERO_WIDTH = /[\u0300-\u036f\u200b-\u200f\u2060-\u2064\ufe00-\ufe0f]/u
const WIDE =
  /[\u1100-\u115f\u2329-\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u

function detectDepth() {
  if (process.env.OC_PLAIN === "1") return 0
  if (process.env.NO_COLOR !== undefined) return 0
  if (process.env.OC_COLOR === "never") return 0
  if (process.env.OC_COLOR === "truecolor") return 24
  if (process.env.OC_COLOR === "256") return 8
  if (process.env.OC_COLOR === "16") return 4
  if (!process.stdout.isTTY) return 0
  const depth = typeof process.stdout.getColorDepth === "function" ? process.stdout.getColorDepth() : 1
  return Number(depth) || 1
}

let depth = detectDepth()

export function setDepth(value) {
  depth = Number(value) || 0
}

export function depthBits() {
  return depth
}

export function colorsEnabled() {
  return depth >= 4
}

export const colors = PALETTE

export function hexToRgb(hex) {
  const value = String(hex).replace("#", "")
  const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value.padEnd(6, "0")
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

function toXterm256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const step = (value) => Math.round((value / 255) * 5)
  return 16 + step(r) * 36 + step(g) * 6 + step(b)
}

function toAnsi16([r, g, b]) {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < 16; i++) {
    const [cr, cg, cb] = hexToRgb(ANSI16[i])
    const distance = (r - cr) ** 2 * 3 + (g - cg) ** 2 * 6 + (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return { index: best, bright: luminance > 0.55 }
}

export function fgCode(color) {
  if (!depth) return ""
  const [r, g, b] = hexToRgb(color)
  if (depth >= 24) return `${ESC}[38;2;${r};${g};${b}m`
  if (depth >= 8) return `${ESC}[38;5;${toXterm256([r, g, b])}m`
  const { index, bright } = toAnsi16([r, g, b])
  return `${ESC}[${bright ? 90 : 30 + (index % 8)}m`
}

export function bgCode(color) {
  if (!depth) return ""
  const [r, g, b] = hexToRgb(color)
  if (depth >= 24) return `${ESC}[48;2;${r};${g};${b}m`
  if (depth >= 8) return `${ESC}[48;5;${toXterm256([r, g, b])}m`
  const { index, bright } = toAnsi16([r, g, b])
  return `${ESC}[${bright ? 100 : 40 + (index % 8)}m`
}

/**
 * OpenCode's selectedForeground rule: pick black or white text for a given
 * background by relative luminance.
 */
export function onColor(background) {
  const [r, g, b] = hexToRgb(background)
  return 0.299 * r + 0.587 * g + 0.114 * b > 127.5 ? PALETTE.background : "#ffffff"
}

export function paint(text, options = {}) {
  const value = String(text ?? "")
  if (!depth) return value
  let prefix = ""
  if (options.fg) prefix += fgCode(options.fg)
  if (options.bg) prefix += bgCode(options.bg)
  if (options.bold) prefix += `${ESC}[1m`
  if (options.dim) prefix += `${ESC}[2m`
  if (!prefix) return value
  return `${prefix}${value}${ESC}[0m`
}

export const bold = (text) => paint(text, { bold: true })
export const dim = (text) => paint(text, { fg: PALETTE.textMuted })
export const accent = (text) => paint(text, { fg: PALETTE.accent, bold: true })
export const text = (value) => paint(value, { fg: PALETTE.text })

export function stripAnsi(value) {
  return String(value ?? "").replace(CSI, "")
}

export function displayWidth(value) {
  let width = 0
  for (const character of stripAnsi(value)) {
    if (ZERO_WIDTH.test(character)) continue
    if (character === "\u200b") continue
    width += WIDE.test(character) ? 2 : 1
  }
  return width
}

export function truncateTo(value, max) {
  const source = String(value ?? "")
  if (max <= 0) return ""
  if (displayWidth(source) <= max) return source
  const limit = max - 1
  let width = 0
  let out = ""
  for (const character of source) {
    const step = WIDE.test(character) ? 2 : 1
    if (width + step > limit) break
    out += character
    width += step
  }
  return `${out}\u2026`
}

export function truncateLeft(value, max) {
  const source = String(value ?? "")
  if (max <= 0) return ""
  if (displayWidth(source) <= max) return source
  const limit = max - 1
  let width = 0
  let out = ""
  for (const character of source) {
    const step = WIDE.test(character) ? 2 : 1
    if (width + step > limit) break
    out += character
    width += step
  }
  return `\u2026${out}`
}

export function padTo(value, width) {
  const text = String(value ?? "")
  const gap = width - displayWidth(text)
  return gap > 0 ? text + " ".repeat(gap) : text
}

export function terminalSize() {
  const forcedWidth = Number(process.env.OC_WIDTH)
  const forcedRows = Number(process.env.OC_ROWS)
  return {
    columns: Number.isFinite(forcedWidth) && forcedWidth > 0 ? forcedWidth : process.stdout.columns || 80,
    rows: Number.isFinite(forcedRows) && forcedRows > 0 ? forcedRows : process.stdout.rows || 24,
  }
}

export const ESCAPE = ESC
export const CSI_RESET = `${ESC}[0m`
export const CURSOR_HIDE = `${ESC}[?25l`
export const CURSOR_SHOW = `${ESC}[?25h`
export const CLEAR_LINE = `${ESC}[2K`
export const CLEAR_SCREEN = `${ESC}[2J\u001b[H\u001b[3J`