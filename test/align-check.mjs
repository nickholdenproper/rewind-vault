import { EventEmitter } from "node:events"
import assert from "node:assert/strict"

const realWrite = process.stdout.write.bind(process.stdout)
let current = ""
process.stdout.write = (text) => {
  current += text
  return true
}
process.stderr.write = () => true

const stdin = new EventEmitter()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.resume = () => stdin
stdin.pause = () => stdin
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
process.env.OC_PLAIN = "1"
process.env.OC_WIDTH = "100"
process.env.OC_ROWS = "40"

const { dialog } = await import("../lib/ui.mjs")
const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
async function keys(items) {
  for (const key of items) {
    stdin.emit("data", Buffer.from(key, "utf8"))
    await delay()
  }
}

const groups = [
  {
    label: "Today",
    items: [
      { value: "a", title: "eroticflix", footer: "EF · 848 msgs", preview: "891.4 KB · saved 2h ago" },
      { value: "b", title: "vault-ui-redesign", footer: "Temp · 96 msgs", preview: "12.1 KB · saved 40m ago" },
    ],
  },
]

const pending = dialog({ title: "Load a session", byline: "", subheading: "vault", groups: () => groups, hints: [{ key: "enter", label: "open" }] })
await delay(120)

const strip = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
const frame = strip(current).replace(/\r\n/g, "\n")
current = ""
const lines = frame.split("\n").filter((line) => line.trim().length > 0)
const at = (text) => lines.findIndex((line) => line.includes(text))
const column = (text) => lines.find((line) => line.includes(text)).indexOf(text)

const rows = ["eroticflix", "vault-ui-redesign"]
const columns = rows.map(column)
const previewColumn = column("891.4 KB")

realWrite(`row columns: ${JSON.stringify(columns)} preview column: ${previewColumn}\n`)
assert.equal(new Set(columns).size, 1, `titles are not aligned: ${JSON.stringify(columns)}`)
assert.equal(previewColumn, columns[0], `preview is not aligned with titles (${previewColumn} vs ${columns[0]})`)

for (const line of lines) {
  assert.equal(line.length, 94, `panel line is ${line.length} wide, expected 94 (6 lead + 88 panel): ${JSON.stringify(line)}`)
}
realWrite("panel width consistent: 94 (6 lead + 88 panel)\n")

await keys(["\u001b[B"])
const moved = strip(current).replace(/\r\n/g, "\n")
current = ""
const after = moved.split("\n").filter((line) => line.trim().length > 0)
assert.equal(column("eroticflix"), columns[0], "moving the cursor shifted the title column")
assert.ok(after.some((line) => line.includes("12.1 KB")), "the preview should follow the selected row")
assert.ok(!after.some((line) => line.includes("891.4 KB")), "stale preview text left on screen")
realWrite("cursor move keeps alignment and moves the preview\n")

await keys(["\u001b"])
await pending
realWrite("\nlayout checks passed\n")
process.exit(0)