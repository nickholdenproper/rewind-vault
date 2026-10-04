import readline from "node:readline"
import { spawnSync } from "node:child_process"
import {
  CLEAR_LINE,
  CLEAR_SCREEN,
  CSI_RESET,
  CURSOR_HIDE,
  CURSOR_SHOW,
  colors,
  displayWidth,
  onColor,
  paint,
  terminalSize,
  truncateTo,
} from "./theme.mjs"

const ESC = "\u001b"

export const PANEL_WIDTH = 88
export const BYLINE = "by Hindham"

// The wordmark is kept as one block, eight rows tall, exactly as drawn: the
// glyphs already carry their own side bearings, so no letter spacing is added.
const BIG_WORDS = {
  REWIND: [
    "███████████   ██████████ █████   ███   █████ █████ ██████   █████ ██████████",
    "▒▒███▒▒▒▒▒███ ▒▒███▒▒▒▒▒█▒▒███   ▒███  ▒▒███ ▒▒███ ▒▒██████ ▒▒███ ▒▒███▒▒▒▒███",
    " ▒███    ▒███  ▒███  █ ▒  ▒███   ▒███   ▒███  ▒███  ▒███▒███ ▒███  ▒███   ▒▒███",
    " ▒██████████   ▒██████    ▒███   ▒███   ▒███  ▒███  ▒███▒▒███▒███  ▒███    ▒███",
    " ▒███▒▒▒▒▒███  ▒███▒▒█    ▒▒███  █████  ███   ▒███  ▒███ ▒▒██████  ▒███    ▒███",
    " ▒███    ▒███  ▒███ ▒   █  ▒▒▒█████▒█████▒    ▒███  ▒███  ▒▒█████  ▒███    ███",
    " █████   █████ ██████████    ▒▒███ ▒▒███      █████ █████  ▒▒█████ ██████████",
    "▒▒▒▒▒   ▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒      ▒▒▒   ▒▒▒      ▒▒▒▒▒ ▒▒▒▒▒    ▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒",
  ],
}

export function bigText(word) {
  const art = BIG_WORDS[String(word ?? "").trim().toUpperCase()]
  if (!art) return undefined
  const width = Math.max(...art.map((line) => displayWidth(line)))
  return art.map((line) => line + " ".repeat(width - displayWidth(line)))
}

// Wipes the viewport, the cursor position and the scrollback, so the Windows
// version banner and the shell prompt that launched us go away too, then falls
// back to `cls` for console hosts that ignore the ANSI sequences.
export function clearScreen() {
  process.stdout.write(CLEAR_SCREEN)
  if (process.platform === "win32") {
    const shell = process.env.ComSpec || "cmd.exe"
    spawnSync(shell, ["/c", "cls"], { stdio: "ignore", windowsHide: true })
  }
}

const INSET = 4
const HEADER_COL = 4
const SCROLL_PAD = 1
const GUTTER_COL = 5
const TITLE_COL = 8
const RIGHT_EDGE = 3
const MIN_LIST_ROWS = 3
const MAX_TITLE = 61

function withRawInput(setup) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("this prompt needs an interactive terminal"))
      return
    }
    let settled = false
    let drawn = 0

    const paintLines = (lines) => {
      const out = []
      if (drawn > 0) out.push(`${ESC}[${drawn}A`)
      for (const line of lines) out.push(CLEAR_LINE, line, "\r\n")
      for (let i = lines.length; i < drawn; i++) out.push(CLEAR_LINE, "\r\n")
      drawn = lines.length
      process.stdout.write(out.join(""))
    }

    const finish = (error, value) => {
      if (settled) return
      settled = true
      process.stdin.off("keypress", onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      if (drawn > 0) process.stdout.write(`${ESC}[${drawn}A${ESC}[0J`)
      process.stdout.write(CURSOR_SHOW)
      if (error) reject(error)
      else resolve(value)
    }

    function onKey(ch, key) {
      if (settled) return
      try {
        const result = setup.handle(ch, key, { paint: paintLines, finish })
        if (result !== undefined) finish(undefined, result)
      } catch (error) {
        finish(error)
      }
    }

    process.stdin.setRawMode(true)
    process.stdin.resume()
    readline.emitKeypressEvents(process.stdin)
    process.stdout.write(CURSOR_HIDE)
    process.stdin.on("keypress", onKey)
    try {
      setup.start({ paint: paintLines, finish })
    } catch (error) {
      finish(error)
    }
  })
}

function panelGeometry() {
  const { columns, rows } = terminalSize()
  const width = Math.max(30, Math.min(PANEL_WIDTH, columns - 2))
  return { columns, rows, width, pad: Math.max(0, Math.floor((columns - width) / 2)) }
}

function panelLines(body) {
  const { width, pad } = panelGeometry()
  const lead = " ".repeat(pad)
  const panel = paint("", { bg: colors.backgroundPanel })
  return body.map((line) => {
    const value = typeof line === "string" ? { text: line } : line
    const indent = value.indent || 0
    const background = value.bg || colors.backgroundPanel
    const gap = Math.max(0, width - indent - displayWidth(value.text))
    const prefix = indent > 0 ? " ".repeat(indent) : ""
    const own = background === colors.backgroundPanel ? "" : paint("", { bg: background })
    return `${lead}${CSI_RESET}${panel}${prefix}${own}${value.text}${" ".repeat(gap)}${CSI_RESET}`
  })
}

function scoreMatch(needle, haystack) {
  const query = String(needle || "").toLowerCase()
  const target = String(haystack || "").toLowerCase()
  if (!query) return 0
  const at = target.indexOf(query)
  if (at === 0) return 0
  if (at > 0) return 10 + at
  let cursor = 0
  let last = -1
  let gaps = 0
  for (const character of target) {
    if (character !== query[cursor]) continue
    if (last >= 0) gaps += cursor - last - 1
    last = cursor
    cursor++
    if (cursor === query.length) return 100 + gaps
  }
  return -1
}

function fuzzyFilter(query, groups) {
  const needle = String(query || "").trim()
  if (!needle) return groups
  const out = []
  for (const group of groups) {
    const items = group.items
      .map((item) => {
        const byTitle = scoreMatch(needle, item.title)
        const byGroup = scoreMatch(needle, group.label)
        const best = Math.min(byTitle < 0 ? Infinity : byTitle * 2, byGroup < 0 ? Infinity : byGroup)
        return best === Infinity ? undefined : { item, best }
      })
      .filter(Boolean)
      .sort((a, b) => a.best - b.best || a.item.title.localeCompare(b.item.title))
      .map((entry) => entry.item)
    if (items.length) out.push({ label: group.label, items })
  }
  return out
}

function centre(text, width) {
  return " ".repeat(Math.max(0, Math.floor((width - displayWidth(text)) / 2))) + text
}

function tailText(value, max) {
  const source = Array.from(String(value ?? ""))
  if (displayWidth(source.join("")) <= max) return source.join("")
  let out = ""
  let width = 0
  for (let i = source.length - 1; i >= 0; i--) {
    const step = displayWidth(source[i]) || 1
    if (width + step > Math.max(1, max - 1)) break
    out = source[i] + out
    width += step
  }
  return `\u2026${out}`
}

/**
 * Mirrors OpenCode's DialogSelect: title + esc header, search line, accent
 * category headers, rows filled with `primary` when selected, footer hints.
 */
export async function dialog({
  title,
  byline = BYLINE,
  banner,
  subheading,
  placeholder = "Search",
  filter = true,
  groups: source,
  hints = [],
  actions = [],
  empty = "No results found",
  initial = 0,
  clear = false,
}) {
  const state = { query: "", selected: Math.max(0, initial), armed: undefined, start: 0 }
  const allGroups = () => (typeof source === "function" ? source() : source) || []
  const view = () => fuzzyFilter(state.query, allGroups())
  const flatten = () => view().flatMap((group) => group.items)

  const layout = () => {
    const list = view()
    const lines = []
    const offsets = new Map()
    let index = 0
    list.forEach((group, groupIndex) => {
      if (group.label) {
        if (groupIndex > 0) lines.push({ text: "" })
        lines.push({ text: " ".repeat(HEADER_COL) + paint(group.label, { fg: colors.accent, bold: true }) })
      }
      for (const item of group.items) {
        offsets.set(index, lines.length)
        lines.push({ row: item, index })
        if (index === state.selected && item.preview) lines.push({ preview: item.preview })
        index++
      }
    })
    return { lines, offsets, flat: list.flatMap((group) => group.items) }
  }

  const row = (item, index, action) => {
    const { width } = panelGeometry()
    const selected = index === state.selected
    const armed = selected && action !== undefined
    const background = armed ? colors.error : selected ? colors.primary : colors.backgroundPanel
    const foreground = selected ? onColor(background) : item.muted ? colors.textMuted : colors.text
    const label = armed ? action.confirm : item.title
    const rightEdge = width - RIGHT_EDGE
    const room = Math.max(4, rightEdge - TITLE_COL)
    const footerBudget = Math.max(8, Math.floor(room * 0.4))
    const footer = item.footer && !armed ? tailText(item.footer, footerBudget) : ""
    const title = truncateTo(String(label ?? ""), Math.min(MAX_TITLE, Math.max(4, room - (footer ? displayWidth(footer) + 1 : 0))))
    const used = TITLE_COL + displayWidth(title) + (footer ? displayWidth(footer) + 1 : 0)
    const mark = item.gutter || "\u25cf"
    const gutter = selected
      ? paint(mark, { fg: foreground, bg: background })
      : item.gutter
        ? paint(item.gutter, { fg: colors.textMuted })
        : " "
    const head = selected
      ? paint(title, { fg: foreground, bg: background, bold: true })
      : paint(title, { fg: foreground })
    const tail = footer
      ? `${selected ? paint(" ", { bg: background }) : " "}${paint(footer, { fg: selected ? foreground : colors.textMuted, bg: selected ? background : undefined })}`
      : ""
    const text = `${" ".repeat(GUTTER_COL)}${gutter}  ${head}${tail}${" ".repeat(Math.max(0, width - 2 - used))}`
    return { text, bg: background, indent: SCROLL_PAD }
  }

  const render = (paintFrame) => {
    const { rows, columns, width } = panelGeometry()
    const { lines, offsets, flat } = layout()
    const drawn = banner ? bigText(banner) : undefined
    const art = drawn && displayWidth(drawn[0]) + 1 <= columns && rows >= drawn.length + 12 ? drawn : undefined

    const head = [{ text: " " }]
    const titleText = String(title ?? "")
    const credit = byline ? paint(byline, { fg: colors.textMuted }) : ""

    if (art) {
      for (const line of art) head.push({ text: centre(paint(line, { fg: colors.primary }), width) })
      if (credit) head.push({ text: centre(credit, width) })
      head.push({ text: " " })
    } else {
      const right = paint("esc", { fg: colors.textMuted })
      const used = INSET + displayWidth(titleText) + (credit ? displayWidth(credit) + 2 : 0) + displayWidth("esc")
      head.push({
        text:
          " ".repeat(INSET) +
          paint(titleText, { fg: colors.text, bold: true }) +
          (credit ? " ".repeat(Math.max(1, width - used)) + credit + "  " : " ".repeat(Math.max(1, width - INSET - displayWidth(titleText) - displayWidth("esc")))) +
          right,
      })
    }

    if (subheading) {
      const value = typeof subheading === "function" ? subheading() : subheading
      const muted = paint(value, { fg: colors.textMuted })
      head.push({ text: art ? centre(muted, width) : " ".repeat(INSET) + muted })
    }
    if (filter) {
      if (subheading) head.push({ text: " " })
      head.push({
        text: " ".repeat(INSET) + paint(state.query, { fg: colors.textMuted }) + paint(state.query ? "\u2588" : `${placeholder} `, { fg: colors.primary }),
      })
    }
    head.push({ text: " " })

    const list = (typeof hints === "function" ? hints(state) : hints) || []
    const footer = [{ text: " " }]
    if (list.length) {
      footer.push({
        text: " ".repeat(INSET) + list
          .map((hint) => (hint.armed ? paint(hint.key, { fg: colors.error, bold: true }) + " " + paint(hint.label, { fg: colors.error }) : paint(hint.key, { fg: colors.text, bold: true }) + " " + paint(hint.label, { fg: colors.textMuted })))
          .join("  "),
      })
      footer.push({ text: " " })
    }

    const body = []

    if (!flat.length) {
      if (filter) body.push({ text: "" })
      body.push({ text: " ".repeat(HEADER_COL) + paint(empty, { fg: colors.textMuted }) })
    } else {
      state.selected = Math.min(state.selected, flat.length - 1)
      const room = Math.max(1, rows - head.length - footer.length)
      const maxRows = Math.max(Math.min(MIN_LIST_ROWS, room), Math.min(lines.length, room))
      const cursor = offsets.get(state.selected) ?? 0
      if (cursor < state.start) state.start = cursor
      if (cursor >= state.start + maxRows) state.start = cursor - maxRows + 1
      state.start = Math.max(0, Math.min(state.start, Math.max(0, lines.length - maxRows)))
      for (const line of lines.slice(state.start, state.start + maxRows)) {
        if (!line.row) {
          body.push({
            indent: SCROLL_PAD,
            text: line.preview ? " ".repeat(TITLE_COL) + paint(truncateTo(line.preview, width - TITLE_COL - 3), { fg: colors.textMuted }) : " " + line.text,
          })
        } else {
          const armedAction = line.index === state.selected ? actions.find((item) => item.id === state.armed) : undefined
          body.push(row(line.row, line.index, armedAction))
        }
      }
    }

    paintFrame(panelLines([...head, ...body, ...footer]))
  }

  const move = (delta) => {
    const total = flatten().length
    if (!total) return
    state.armed = undefined
    state.selected = (state.selected + delta + total) % total
  }

  const jump = (index) => {
    const total = flatten().length
    if (!total) return
    state.armed = undefined
    state.selected = Math.max(0, Math.min(total - 1, index))
  }

  const handle = (ch, key, api) => {
    if (key.name === "c" && key.ctrl) return api.finish(new Error("aborted"))
    if (key.name === "escape") return { action: "cancel" }
    if (key.name === "return") {
      const item = flatten()[state.selected]
      return { action: "select", value: item ? item.value : undefined }
    }
    if (key.name === "up") move(-1)
    else if (key.name === "down") move(1)
    else if (key.name === "pageup") move(-10)
    else if (key.name === "pagedown") move(10)
    else if (key.name === "home") jump(0)
    else if (key.name === "end") jump(flatten().length - 1)
    else if (key.name === "backspace") {
      if (filter && state.query) {
        state.query = state.query.slice(0, -1)
        state.selected = 0
        state.start = 0
      }
    } else if (filter && ch && !key.ctrl && !key.meta && ch >= " ") {
      state.query += ch
      state.selected = 0
      state.start = 0
    } else {
      const action = actions.find((item) => key.name === item.key && Boolean(key.ctrl) === Boolean(item.ctrl))
      if (!action) return undefined
      const item = flatten()[state.selected]
      if (!item) return undefined
      const ctx = {
        armed: state.armed === action.id,
        arm: () => {
          state.armed = action.id
        },
        disarm: () => {
          state.armed = undefined
        },
        rerender: () => {
          state.armed = undefined
          state.selected = Math.min(state.selected, Math.max(0, flatten().length - 1))
        },
      }
      const result = action.run(item.value, ctx)
      if (result && typeof result.then === "function") {
        result.then((value) => {
          if (value && value.close !== undefined) api.finish(undefined, { action: action.id, value: value.close })
          else render(api.paint)
        })
        return undefined
      }
      if (result && result.close !== undefined) return { action: action.id, value: result.close }
      render(api.paint)
      return undefined
    }
    render(api.paint)
    return undefined
  }

  return withRawInput({
    start(api) {
      if (clear) clearScreen()
      render(api.paint)
    },
    handle,
  })
}

export async function promptText({ title, hint, initial = "", validate, allowEmpty = false }) {
  const state = { value: initial, error: undefined }

  const render = (paintFrame) => {
    const { width } = panelGeometry()
    const label = String(title ?? "")
    const lines = [{ text: " " }]
    lines.push({
      text:
        " ".repeat(INSET) +
        paint(label, { fg: colors.text, bold: true }) +
        (hint ? " ".repeat(Math.max(1, width - INSET - displayWidth(label) - displayWidth(hint))) + paint(hint, { fg: colors.textMuted }) : ""),
    })
    lines.push({ text: " " })
    lines.push({ text: " ".repeat(INSET) + paint(state.value, { fg: colors.textMuted }) + paint("\u2588", { fg: colors.primary }) })
    if (state.error) {
      lines.push({ text: " " })
      lines.push({ text: " ".repeat(INSET) + paint(state.error, { fg: colors.error }) })
    }
    lines.push({ text: " " })
    lines.push({
      text:
        " ".repeat(INSET) +
        paint("enter confirm", { fg: colors.text, bold: true }) +
        " " +
        paint("esc cancel", { fg: colors.textMuted }),
    })
    lines.push({ text: " " })
    paintFrame(panelLines(lines))
  }

  return withRawInput({
    start(api) {
      render(api.paint)
    },
    handle(ch, key, api) {
      if (key.name === "c" && key.ctrl) return api.finish(new Error("aborted"))
      if (key.name === "escape") return null
      if (key.name === "return") {
        const problem = !allowEmpty && !state.value.trim() ? "a value is required" : validate ? validate(state.value) : undefined
        if (problem) {
          state.error = problem
          render(api.paint)
          return undefined
        }
        return state.value
      }
      if (key.name === "backspace") state.value = state.value.slice(0, -1)
      else if (ch && !key.ctrl && !key.meta && ch >= " ") state.value += ch
      else return undefined
      state.error = undefined
      render(api.paint)
      return undefined
    },
  })
}

export function info(message) {
  process.stdout.write(`${message}\n`)
}

export function notify(message) {
  if (!process.stdin.isTTY) {
    info(message)
    return Promise.resolve()
  }
  return withRawInput({
    start(api) {
      api.paint(
        panelLines([
          { text: " " },
          { text: " ".repeat(INSET) + paint(message, { fg: colors.text }) },
          { text: " " },
          { text: " ".repeat(INSET) + paint("press enter to continue", { fg: colors.textMuted }) },
          { text: " " },
        ]),
      )
    },
    handle(_ch, key) {
      if (key.name === "c" && key.ctrl) return "cancelled"
      if (key.name === "return" || key.name === "escape") return "ok"
      return undefined
    },
  })
}

const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]

export async function withSpinner(label, fn) {
  if (!process.stdin.isTTY) {
    info(label)
    return fn()
  }
  const started = Date.now()
  let frame = 0
  process.stdout.write(`${paint(SPINNER_FRAMES[0], { fg: colors.primary })} ${paint(label, { fg: colors.textMuted })}`)
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length
    const seconds = Math.round((Date.now() - started) / 1000)
    process.stdout.write(
      `${CLEAR_LINE}\r${paint(SPINNER_FRAMES[frame], { fg: colors.primary })} ${paint(label, { fg: colors.textMuted })} ${paint(`${seconds}s`, { fg: colors.textMuted })}`,
    )
  }, 120)
  try {
    const result = await fn()
    clearInterval(timer)
    process.stdout.write(CLEAR_LINE + "\r")
    return result
  } catch (error) {
    clearInterval(timer)
    process.stdout.write(CLEAR_LINE + "\r")
    throw error
  }
}

export function ok(message) {
  info(`${paint("\u2714", { fg: colors.success })} ${message}`)
}

export function bad(message) {
  info(`${paint("\u2716", { fg: colors.error })} ${message}`)
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function relativeTime(value) {
  const ms = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return "unknown"
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function dayGroup(value) {
  const ms = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return "unknown"
  const date = new Date(ms)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === new Date(today.getTime() - 86400000).toDateString()) return "Yesterday"
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" })
}

export function folderName(directory) {
  const value = String(directory || "")
  if (!value) return "unknown folder"
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || value
}