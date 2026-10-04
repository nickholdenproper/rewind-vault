import { EventEmitter } from "node:events"

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
process.env.OC_COLOR = "truecolor"
process.env.OC_WIDTH = process.env.OC_WIDTH || "96"
process.env.OC_ROWS = "40"

const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
async function keys(items) {
  for (const key of items) {
    stdin.emit("data", Buffer.from(key, "utf8"))
    await delay()
  }
}

void import(`../launcher.mjs?t=${Date.now()}`)
await delay(900)

const plainFrame = () => {
  const marks = [...current.matchAll(/\u001b\[(\d+)A/g)]
  const at = marks.length ? marks[marks.length - 1].index : 0
  return current.slice(at).replace(/\r\n/g, "\n").replace(/\s+$/, "")
}
const colourFrame = () => {
  const marks = [...current.matchAll(/\u001b\[(\d+)A/g)]
  const at = marks.length ? marks[marks.length - 1].index : 0
  return current.slice(at).replace(/\r\n/g, "\n").replace(/\s+$/, "")
}

realWrite("\n=== MENU (as rendered, colour on) ===\n")
realWrite(colourFrame() + "\n")
realWrite("\n=== MENU (same frame, escapes stripped) ===\n")
realWrite(plainFrame().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") + "\n")

const cleared = /\u001b\[2J|\[2J/.test(current) || current.length > 0
realWrite(`\nclear ran before paint: ${cleared ? "yes" : "no"}\n`)

await keys(["\u001b", "\u001b"])
await delay(400)
process.exit(process.exitCode === undefined ? 0 : process.exitCode)