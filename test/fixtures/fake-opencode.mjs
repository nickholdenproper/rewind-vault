#!/usr/bin/env node
/**
 * A stand-in for the opencode binary, pointed at by OPENCODE_BIN.
 *
 * It answers the two commands the archive path uses:
 *   opencode db "<sql>" --format json   -> a fixed session list
 *   opencode export <sessionID>        -> a gzipped JSON blob on stdout
 *
 * The session directories it reports deliberately use forward slashes, because
 * that is what opencode really writes and what the matching in store.mjs has to
 * cope with.
 */
import zlib from "node:zlib"

const args = process.argv.slice(2)
const command = args[0]

/**
 * Applies a `directory IN (...)` restriction the way SQLite would, so a query
 * that filters folders in SQL gets the same answer here as it would against the
 * real database. `IN` on text uses BINARY collation, which is an exact byte
 * comparison -- that is the whole reason the archive path stopped filtering
 * directories in SQL, and this is what makes that visible in a test.
 */
function applyDirectoryFilter(sql, rows) {
  const match = /directory\s+IN\s*\(([^)]*)\)/i.exec(sql)
  if (!match) return rows
  const wanted = new Set([...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((item) => item[1].replace(/''/g, "'")))
  return rows.filter((row) => wanted.has(row.directory))
}

if (command === "db") {
  const sql = args[1] || ""
  const rows = applyDirectoryFilter(sql, JSON.parse(process.env.FAKE_OPENCODE_ROWS || "[]"))
  if (!sql || /path\s*$/i.test(sql.trim())) {
    process.stdout.write(`${process.env.FAKE_OPENCODE_DB || ""}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`)
  }
  process.exit(0)
}

if (command === "export") {
  const id = args[1]
  if (process.env.FAKE_OPENCODE_SILENT === "1") {
    // Exits without writing anything, so `close` arrives before the stdout pipe
    // finishes draining. That is the race exportSessionTo has to survive.
    process.exit(0)
  }
  const rows = JSON.parse(process.env.FAKE_OPENCODE_ROWS || "[]")
  const row = rows.find((item) => item.id === id) || { id, title: id }
  // Real exports of a long session take seconds. Tests use this to prove the menu
  // does not sit behind the archive pass before it paints.
  const slow = Number(process.env.FAKE_OPENCODE_EXPORT_MS || 0)
  if (slow > 0) {
    const until = Date.now() + slow
    while (Date.now() < until) {}
  }
  process.stdout.write(zlib.gzipSync(Buffer.from(JSON.stringify({ session: row, messages: [] }))))
  process.exit(0)
}

if (command === "--version") {
  process.stdout.write("0.0.0-fake\n")
  process.exit(0)
}

process.stderr.write(`fake-opencode: unsupported command ${JSON.stringify(args)}\n`)
process.exit(1)
