import { EventEmitter } from "node:events"

const realWrite = process.stdout.write.bind(process.stdout)
let current = ""
process.stdout.write = (text) => {
  current += text
  return true
}
process.stderr.write = (text) => {
  current += text
  return true
}

const stdin = new EventEmitter()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.resume = () => stdin
stdin.pause = () => stdin
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
delete process.env.OC_PLAIN
process.env.OC_COLOR = "truecolor"
process.env.OC_WIDTH = "96"
process.env.OC_ROWS = "40"

const store = await import("../lib/store.mjs")
const { dialog, dayGroup, formatBytes, folderName, relativeTime } = await import("../lib/ui.mjs")

const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
async function keys(items) {
  for (const key of items) {
    stdin.emit("data", Buffer.from(key, "utf8"))
    await delay()
  }
}

function frame() {
  const marks = [...current.matchAll(/\u001b\[(\d+)A/g)]
  const at = marks.length ? marks[marks.length - 1].index : 0
  return current.slice(at).replace(/\r\n/g, "\n").replace(/\s+$/, "")
}

const stats = await store.vaultStats()
const entries = (await store.readIndex()).sessions

const menu = dialog({
  title: "Rewind",
  subheading: `${stats.sessions} archived · ${formatBytes(stats.bytes)} · ${stats.snapshots} snapshot${stats.snapshots === 1 ? "" : "s"} · ${store.VAULT}`,
  filter: false,
  groups: [
    {
      label: "",
      items: [
        { value: "load", title: "Load a session", footer: stats.sessions ? `${stats.sessions} saved` : "nothing saved yet", preview: stats.sessions ? `archives live in ${store.SESSIONS_DIR}` : "save a session to build the vault" },
        { value: "save", title: "Save a session", footer: "archive recent sessions", preview: "exports recent sessions from the opencode database" },
        { value: "backup", title: "Back up session database", footer: "vacuumed snapshot", preview: `writes opencode-<timestamp>.db into ${store.DB_DIR}` },
        { value: "plain", title: "Start opencode without a session", footer: "default", preview: `plain opencode in ${process.cwd()}` },
      ],
    },
  ],
  hints: [{ key: "enter", label: "select" }, { key: "esc", label: "start opencode" }],
})
await delay(150)
realWrite("\n\x1b[0m\x1b[48;2;10;10;10m  MAIN MENU (real vault data, truecolor)  \x1b[0m\n\n")
realWrite(frame() + "\n")
await keys(["\u001b"])
await menu

const load = dialog({
  title: "Load a session",
  byline: "",
  subheading: `${store.VAULT}  ·  ${entries.length} saved  ·  ${formatBytes(entries.reduce((sum, e) => sum + (e.bytes || 0), 0))}`,
  groups: () => {
    const groups = new Map()
    for (const entry of entries) {
      const label = dayGroup(entry.savedAt)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push({
        value: entry,
        title: entry.label,
        footer: `${folderName(entry.directory)} · ${entry.messages || 0} msgs`,
        preview: `${formatBytes(entry.bytes || 0)} · saved ${relativeTime(entry.savedAt)} · ${entry.sessionID} · ${entry.directory || "unknown dir"}`,
      })
    }
    return [...groups].map(([label, items]) => ({ label, items }))
  },
  hints: (state) => [
    { key: "enter", label: "open" },
    { key: "ctrl+r", label: "rename", armed: state.armed === "rename" },
    { key: "ctrl+d", label: "delete", armed: state.armed === "delete" },
  ],
  actions: [{ id: "delete", key: "d", ctrl: true, confirm: "Delete for good? ctrl+d again", run: (_v, ctx) => ctx.arm() }],
})
await delay(150)
realWrite("\n\x1b[0m\x1b[48;2;10;10;10m  LOAD SCREEN (armed with ctrl+d)  \x1b[0m\n\n")
realWrite(frame() + "\n")
await keys(["\u0004"])
realWrite("\n")
realWrite("\x1b[0m\x1b[48;2;10;10;10m  LOAD SCREEN after ctrl+d (confirm state)  \x1b[0m\n\n")
realWrite(frame() + "\n")
await keys(["\u001b"])
await load
realWrite("\x1b[0m\n")
process.exit(0)