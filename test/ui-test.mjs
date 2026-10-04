import { EventEmitter } from "node:events"
import assert from "node:assert/strict"

const realWrite = process.stdout.write.bind(process.stdout)
const realError = process.stderr.write.bind(process.stderr)
let full = ""
let pending = ""
const capture = (text) => {
  full += text
  pending += text
  return true
}
process.stdout.write = capture
process.stderr.write = capture

const stdin = new EventEmitter()
stdin.isTTY = true
const rawModes = []
stdin.setRawMode = (value) => {
  rawModes.push(value)
  return stdin
}
stdin.resume = () => stdin
stdin.pause = () => stdin
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })

process.env.OC_PLAIN = "1"
process.env.OC_WIDTH = "100"
process.env.OC_ROWS = "40"

const ui = await import("../lib/ui.mjs")
const theme = await import("../lib/theme.mjs")
const { dialog, promptText, notify } = ui

const ENTER = "\r"
const DOWN = "\u001b[B"
const UP = "\u001b[A"
const ESC = "\u001b"
const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const CTRL_R = "\u0012"
const BACKSPACE = "\u007f"

const delay = (ms = 45) => new Promise((resolve) => setTimeout(resolve, ms))
const plain = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")

function lastFrame(source = full) {
  const marks = [...source.matchAll(/\u001b\[(\d+)A/g)]
  const at = marks.length ? marks[marks.length - 1].index : 0
  return plain(source.slice(at))
}

async function keys(items, settle = 45) {
  for (const key of items) {
    stdin.emit("data", Buffer.from(key, "utf8"))
    await delay(settle)
  }
}

async function until(text, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!pending.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${JSON.stringify(text)}\n--- pending ---\n${plain(pending).slice(-1200)}`)
    }
    await delay(30)
  }
  pending = ""
}

async function fresh(fn) {
  stdin.removeAllListeners("keypress")
  full = ""
  pending = ""
  return fn()
}

let passed = 0
async function check(name, fn) {
  full = ""
  pending = ""
  await fn()
  passed++
  realWrite(`  ok  ${name}\n`)
}

const rows = (count, prefix = "session") =>
  Array.from({ length: count }, (_, index) => ({
    value: index,
    title: `${prefix}-${index}`,
    footer: `folder-${index} · ${index} msgs`,
  }))

const oneGroup = (items, label = "Today") => () => [{ label, items }]

await check("dialog returns the first item on enter", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    await until("session-0")
    await keys([ENTER])
    return pendingDialog
  })
  assert.deepEqual(result, { action: "select", value: 0 })
})

await check("dialog moves down then up", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    await until("session-0")
    await keys([DOWN, DOWN, UP])
    await keys([ENTER])
    return pendingDialog
  })
  assert.equal(result.value, 1)
})

await check("dialog wraps from last to first", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    await until("session-0")
    await keys([UP])
    await keys([ENTER])
    return pendingDialog
  })
  assert.equal(result.value, 2, "up from the first row should wrap to the last")
})

await check("dialog honours the initial index", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(4)), filter: false, initial: 2 })
    await until("session-2")
    await keys([ENTER])
    return pendingDialog
  })
  assert.equal(result.value, 2)
})

await check("dialog cancels on escape", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    await until("session-0")
    await keys([ESC])
    return pendingDialog
  })
  assert.deepEqual(result, { action: "cancel" })
})

await check("ctrl+c aborts with the aborted error", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    const settled = pendingDialog.then(
      (value) => ({ resolved: value }),
      (error) => ({ rejected: error.message }),
    )
    await until("session-0")
    await keys([CTRL_C])
    return settled
  })
  assert.deepEqual(result, { rejected: "aborted" })
})

await check("dialog scrolls a list taller than the terminal", async () => {
  process.env.OC_ROWS = "12"
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(30)), filter: false })
    await until("session-0")
    await keys(Array.from({ length: 25 }, () => DOWN), 6)
    await keys([ENTER])
    return pendingDialog
  })
  delete process.env.OC_ROWS
  assert.equal(result.value, 25, "should reach the 26th row by paging down")
  assert.ok(!plain(full).includes("session-29"), "rows far below the window should not be painted")
})

await check("dialog filters as you type and backspace restores", async () => {
  const items = [
    { value: "alpha", title: "eroticflix deploy", footer: "EF" },
    { value: "beta", title: "vault redesign", footer: "Temp" },
    { value: "gamma", title: "eroticflix site", footer: "EF" },
  ]
  const repaint = async () => {
    pending = ""
    await keys([DOWN])
    return plain(pending)
  }
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: () => [{ label: "Today", items }] })
    await until("vault redesign")
    await keys(["erotic"])
    const filtered = await repaint()
    assert.ok(filtered.includes("eroticflix deploy"), "typing should narrow the list")
    assert.ok(!filtered.includes("vault redesign"), "non-matching rows should disappear")
    assert.ok(filtered.includes("eroticflix site"), "both matching rows should stay")
    await keys([BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE])
    const restored = await repaint()
    assert.ok(restored.includes("vault redesign"), "backspace should restore the full list")
    await keys([ENTER])
    return pendingDialog
  })
  assert.equal(result.value, "beta", "backspacing should restore the full list in its original order")
})

await check("type to filter works as a subsequence", async () => {
  const items = [
    { value: "a", title: "abcdef" },
    { value: "b", title: "zzz" },
  ]
  const result = await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: () => [{ label: "Today", items }] })
    await until("abcdef")
    await keys(["ace"])
    await keys([ENTER])
    return pendingDialog
  })
  assert.equal(result.value, "a")
})

await check("ctrl+d needs a second press and then deletes in place", async () => {
  const remaining = new Set(["alpha", "beta"])
  const deleted = []
  const items = () => [{ label: "Today", items: [...remaining].map((value) => ({ value, title: value, footer: "EF" })) }]
  const result = await fresh(async () => {
    const pendingDialog = dialog({
      title: "Load",
      byline: "",
      groups: items,
      hints: (state) => [{ key: "ctrl+d", label: "delete", armed: state.armed === "delete" }],
      actions: [
        {
          id: "delete",
          key: "d",
          ctrl: true,
          confirm: "Delete for good? ctrl+d again",
          run: (value, ctx) => {
            if (!ctx.armed) {
              ctx.arm()
              return undefined
            }
            remaining.delete(value)
            deleted.push(value)
            ctx.rerender()
            return undefined
          },
        },
      ],
    })
    await until("alpha")
    await keys([CTRL_D])
    assert.ok(plain(pending).includes("Delete for good?"), "the first press should arm, not delete")
    assert.deepEqual(deleted, [], "one press must not delete")
    await keys([CTRL_D])
    await delay(120)
    assert.deepEqual(deleted, ["alpha"], "the second press should delete")
    assert.ok(!plain(pending).includes("alpha"), "the deleted row should disappear")
    await keys([ESC])
    return pendingDialog
  })
  assert.deepEqual(result, { action: "cancel" })
})

await check("ctrl+r closes the dialog with a rename intent", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({
      title: "Load",
      byline: "",
      groups: oneGroup([{ value: "alpha", title: "alpha" }]),
      actions: [{ id: "rename", key: "r", ctrl: true, run: (value) => ({ close: { intent: "rename", value } }) }],
    })
    await until("alpha")
    await keys([CTRL_R])
    return pendingDialog
  })
  assert.deepEqual(result, { action: "rename", value: { intent: "rename", value: "alpha" } })
})

await check("an async action that closes resolves through finish", async () => {
  const result = await fresh(async () => {
    const pendingDialog = dialog({
      title: "Load",
      byline: "",
      groups: oneGroup([{ value: "alpha", title: "alpha" }]),
      actions: [{ id: "go", key: "g", ctrl: true, run: async (value) => ({ close: { ok: value } }) }],
    })
    await until("alpha")
    await keys(["\u0007"])
    return pendingDialog
  })
  assert.deepEqual(result, { action: "go", value: { ok: "alpha" } })
})

await check("the panel is borderless and centred", async () => {
  await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(3)), filter: false })
    await until("session-0")
    const lines = lastFrame().split("\r\n").filter((line) => line.trim().length > 0)
    for (const line of lines) {
      for (const glyph of ["\u250c", "\u2510", "\u2514", "\u2518", "\u2500", "\u2502", "\u2551", "\u256d"]) {
        assert.ok(!line.includes(glyph), `panel line contains a border glyph ${glyph}: ${JSON.stringify(line)}`)
      }
    }
    const title = lines.find((line) => line.includes("Load"))
    const lead = title.length - title.trimStart().length
    assert.equal(lead, Math.floor((100 - 88) / 2) + 4, `expected the centring pad plus the 4 column inset, got ${lead}`)
    assert.ok(lines.some((line) => line.includes("esc")), "the header should carry the esc affordance")
    await keys([ESC])
    await pendingDialog
  })
})

await check("the panel clamps its width on a narrow terminal", async () => {
  process.env.OC_WIDTH = "46"
  try {
    await fresh(async () => {
      const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(2)), filter: false })
      await until("session-0")
      const lines = lastFrame().split("\r\n").filter((line) => line.trim().length > 0)
      for (const line of lines) assert.ok(line.length <= 46, `line is ${line.length} wide on a 46 column terminal`)
      assert.ok(lines.some((line) => line.includes("session-0")), "rows should still render")
      await keys([ESC])
      await pendingDialog
    })
  } finally {
    process.env.OC_WIDTH = "100"
  }
})

await check("the wordmark is dropped rather than wrapped on a narrow terminal", async () => {
  process.env.OC_WIDTH = "70"
  try {
    await fresh(async () => {
      const pendingDialog = dialog({ title: "Rewind", banner: "REWIND", byline: "", groups: oneGroup(rows(2)), filter: false })
      await until("session-0")
      const frame = lastFrame()
      assert.ok(!/[█▒]/.test(frame), "a wordmark wider than the terminal must not be drawn")
      assert.ok(frame.includes("Rewind"), "the plain title header should be used instead")
      await keys([ESC])
      await pendingDialog
    })
  } finally {
    process.env.OC_WIDTH = "100"
  }
})

await check("wide characters do not break the row budget", async () => {
  await fresh(async () => {
    const items = [{ value: "cjk", title: "\u4f60\u597d\u4e16\u754c", footer: "\u4e16\u754c \u00b7 5 msgs" }]
    const pendingDialog = dialog({ title: "Load", byline: "", groups: () => [{ label: "Today", items }], filter: false })
    await until("\u4f60\u597d")
    for (const line of lastFrame().split("\r\n")) {
      assert.ok(theme.displayWidth(line) <= 94, `row exceeds the panel: ${theme.displayWidth(line)} (${JSON.stringify(line)})`)
    }
    await keys([ESC])
    await pendingDialog
  })
})

await check("selected rows use the opencode primary fill and dark text", async () => {
  theme.setDepth(24)
  try {
    await fresh(async () => {
      const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(2)), filter: false })
      await until("session-0")
      assert.ok(full.includes(`\u001b[48;2;250;178;131m`), "missing the #fab283 selected-row fill")
      assert.ok(full.includes(`\u001b[38;2;10;10;10m`), "missing the #0a0a0a text on the selected row")
      assert.ok(full.includes(`\u001b[48;2;20;20;20m`), "missing the #141414 panel background")
      assert.ok(full.includes(`\u001b[38;2;128;128;128m`), "missing the #808080 muted text")
      await keys([ESC])
      await pendingDialog
    })
  } finally {
    theme.setDepth(0)
  }
})

await check("category headers use the accent colour", async () => {
  theme.setDepth(24)
  try {
    await fresh(async () => {
      const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(1), "Yesterday"), filter: false })
      await until("Yesterday")
      assert.ok(full.includes(`\u001b[38;2;157;124;216m`), "missing the #9d7cd8 accent")
      await keys([ESC])
      await pendingDialog
    })
  } finally {
    theme.setDepth(0)
  }
})

await check("the menu shows the byline and the load screen does not", async () => {
  await fresh(async () => {
    const withCredit = dialog({ title: "Rewind", groups: oneGroup(rows(1)), filter: false })
    await until("Rewind")
    assert.ok(lastFrame().includes("by Hindham"), "the menu header should credit Hindham")
    await keys([ESC])
    await withCredit

    const withoutCredit = dialog({ title: "Load a session", byline: "", groups: oneGroup(rows(1)), filter: false })
    await until("Load a session")
    assert.ok(!lastFrame().includes("by Hindham"), "the load screen should not repeat the credit")
    await keys([ESC])
    await withoutCredit
  })
})

await check("the preview follows the selected row", async () => {
  await fresh(async () => {
    const items = [
      { value: "a", title: "alpha", preview: "PREVIEW-A" },
      { value: "b", title: "beta", preview: "PREVIEW-B" },
    ]
    const pendingDialog = dialog({ title: "Load", byline: "", groups: () => [{ label: "Today", items }], filter: false })
    await until("PREVIEW-A")
    await keys([DOWN])
    const text = lastFrame()
    assert.ok(text.includes("PREVIEW-B"), "the new selection should show its own preview")
    assert.ok(!text.includes("PREVIEW-A"), "the old preview should be gone")
    await keys([ESC])
    await pendingDialog
  })
})

await check("an empty list shows the empty message", async () => {
  await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: () => [], filter: false, empty: "nothing here yet" })
    await until("nothing here yet")
    await keys([ENTER])
    assert.deepEqual(await pendingDialog, { action: "select", value: undefined })
  })
})

await check("bigText draws REWIND as an eight row block wordmark", async () => {
  const art = ui.bigText("rewind")
  assert.ok(Array.isArray(art), "rewind should be renderable")
  assert.equal(art.length, 8, "the wordmark should be eight rows tall")
  assert.equal(art[0].trimEnd(), "███████████   ██████████ █████   ███   █████ █████ ██████   █████ ██████████", `unexpected first row: ${JSON.stringify(art[0])}`)
  assert.equal(art[7].trimEnd(), "▒▒▒▒▒   ▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒      ▒▒▒   ▒▒▒      ▒▒▒▒▒ ▒▒▒▒▒    ▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒", `unexpected last row: ${JSON.stringify(art[7])}`)
  assert.ok(art.every((line) => /[█▒]/.test(line)), "every row should have strokes")
  const widths = art.map((line) => theme.displayWidth(line))
  assert.equal(Math.max(...widths), Math.min(...widths), `rows should share a width, got ${widths.join(",")}`)
  assert.ok(widths[0] + 2 <= ui.PANEL_WIDTH, `the wordmark should fit the panel, got ${widths[0]} of ${ui.PANEL_WIDTH}`)
  assert.equal(ui.bigText("HELLO"), undefined, "unknown words should fall back")
})

await check("a banner dialog centres the wordmark and the credit", async () => {
  await fresh(async () => {
    const pendingDialog = dialog({
      title: "Rewind",
      banner: "REWIND",
      byline: "by Hindham",
      subheading: "1 archived",
      filter: false,
      groups: oneGroup([{ value: "a", title: "Load a session" }]),
      hints: [{ key: "enter", label: "select" }],
    })
    await until("Load a session")
    const lines = lastFrame().split("\r\n")

    // Everything is measured inside the panel, which excludes the lead that
    // centres the panel in the terminal.
    const columns = theme.terminalSize().columns
    const panelWidth = Math.max(30, Math.min(ui.PANEL_WIDTH, columns - 2))
    const lead = Math.floor((columns - panelWidth) / 2)
    const body = (line) => line.slice(lead, lead + panelWidth)
    const midpoint = (line) => {
      const text = body(line).trim()
      return body(line).indexOf(text) + text.length / 2
    }

    const wordmark = ui.bigText("REWIND")
    const pad = Math.floor((panelWidth - wordmark[0].length) / 2)
    const drawn = lines.map(body).filter((line) => /[█▒]/.test(line))
    assert.equal(drawn.length, 8, "the wordmark should occupy eight lines")
    drawn.forEach((line, index) => {
      assert.equal(line.trimEnd(), (" ".repeat(pad) + wordmark[index]).trimEnd(), `wordmark row ${index} is not the centred art: ${JSON.stringify(line)}`)
    })

    const credit = lines.find((line) => line.includes("by Hindham"))
    assert.ok(credit, "the credit should be shown under the wordmark")
    const status = lines.find((line) => line.includes("1 archived"))
    assert.ok(status, "the status line should still be shown")

    const target = pad + wordmark[0].length / 2
    for (const line of [credit, status]) {
      assert.ok(Math.abs(midpoint(line) - target) <= 0.5, `expected the same centre as the wordmark, got ${midpoint(line)} vs ${target}`)
    }
    assert.ok(lines.indexOf(credit) > lines.indexOf(drawn[7]), "the credit belongs under the wordmark")
    assert.ok(lines.indexOf(status) > lines.indexOf(credit), "the status belongs under the credit")
    assert.ok(lines.indexOf(drawn[0]) < lines.findIndex((line) => line.includes("Load a session")), "the menu belongs under the wordmark")
    assert.ok(!drawn[0].includes("esc"), "a banner replaces the title row that carries esc")
    await keys([ESC])
    await pendingDialog
  })
})

await check("clearScreen erases the viewport, homes the cursor and drops the scrollback", async () => {
  await fresh(async () => {
    ui.clearScreen()
    assert.ok(full.includes("\u001b[2J"), "the viewport must be erased")
    assert.ok(full.includes("\u001b[3J"), "the scrollback must be erased so the Windows banner is gone")
    assert.ok(full.includes("\u001b[H"), "the cursor must return home")
  })
})

await check("clearScreen runs without throwing", async () => {
  await fresh(async () => {
    const pendingDialog = dialog({ title: "Rewind", banner: "REWIND", clear: true, filter: false, groups: oneGroup([{ value: "a", title: "Load a session" }]) })
    await until("Load a session")
    assert.ok(lastFrame().includes("Load a session"), "clearing must not swallow the first paint")
    await keys([ESC])
    await pendingDialog
  })
})

await check("promptText returns typed text", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name this session" })
    await until("Name this session")
    await keys(["vault", ENTER])
    return pendingPrompt
  })
  assert.equal(value, "vault")
})

await check("promptText handles backspace", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name", initial: "abc" })
    await until("Name")
    await keys([BACKSPACE, "z", ENTER])
    return pendingPrompt
  })
  assert.equal(value, "abz")
})

await check("promptText returns null on escape", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name" })
    await until("Name")
    await keys([ESC])
    return pendingPrompt
  })
  assert.equal(value, null)
})

await check("promptText blocks enter until validation passes", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name", validate: (input) => (input.length < 3 ? "too short" : undefined) })
    await until("Name")
    await keys(["ab", ENTER])
    assert.ok(plain(pending).includes("too short"), "the validation message should be shown")
    await keys(["c", ENTER])
    return pendingPrompt
  })
  assert.equal(value, "abc")
})

await check("promptText reports a required value", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name" })
    await until("Name")
    await keys([ENTER])
    assert.ok(plain(pending).includes("a value is required"), "an empty prompt should complain")
    await keys(["ok", ENTER])
    return pendingPrompt
  })
  assert.equal(value, "ok")
})

await check("promptText allows empty when allowEmpty is set", async () => {
  const value = await fresh(async () => {
    const pendingPrompt = promptText({ title: "Name", allowEmpty: true })
    await until("Name")
    await keys([ENTER])
    return pendingPrompt
  })
  assert.equal(value, "")
})

await check("notify waits for enter", async () => {
  await fresh(async () => {
    const pendingNotice = notify("saved the archive")
    await until("press enter to continue")
    await keys([ENTER])
    assert.equal(await pendingNotice, "ok")
  })
})

await check("raw mode and cursor are restored after every prompt", async () => {
  rawModes.length = 0
  await fresh(async () => {
    const pendingDialog = dialog({ title: "Load", byline: "", groups: oneGroup(rows(1)), filter: false })
    await until("session-0")
    await keys([ESC])
    await pendingDialog
  })
  assert.deepEqual(rawModes, [true, false], "raw mode should be enabled then restored")
  assert.ok(full.includes("\u001b[?25l"), "the cursor should be hidden while painting")
  assert.ok(full.includes("\u001b[?25h"), "the cursor should be restored")
  assert.ok(!stdin.listenerCount("keypress"), "the keypress listener should be removed")
})

realWrite(`\n${passed} ui checks passed\n`)
process.exit(process.exitCode === undefined ? 0 : process.exitCode)