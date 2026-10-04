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
import fsp from "node:fs/promises"
import zlib from "node:zlib"

const args = process.argv.slice(2)
const command = args[0]

/**
 * Records every statement it is asked to run, so a test can assert on the SQL
 * that would reach the real database rather than on the source that built it.
 */
async function recordSql(sql) {
  const log = process.env.FAKE_OPENCODE_SQL_LOG
  if (!log) return
  await fsp.appendFile(log, `${sql}\n`)
}

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

/**
 * Applies an `id = '...'` restriction the way SQLite would, so a lookup by id
 * against this fixture agrees with the real database.
 */
function applyIdFilter(sql, rows) {
  const match = /\bid\s*=\s*'((?:[^']|'')*)'/i.exec(sql)
  if (!match) return rows
  const wanted = match[1].replace(/''/g, "'")
  return rows.filter((row) => row.id === wanted)
}

if (command === "db") {
  const sql = args[1] || ""
  await recordSql(sql)
  // The session tree gets its own fixture rows: it is the one query whose answer
  // decides which sessions survive a clear, and it must not be confused with the
  // counts query that shares the same generic row source.
  const treeQuery = /FROM\s+session/i.test(sql) && !/COUNT\s*\(/i.test(sql)
  const rows = treeQuery
    ? applyIdFilter(sql, JSON.parse(process.env.FAKE_OPENCODE_TREE || "[]"))
    : applyDirectoryFilter(sql, JSON.parse(process.env.FAKE_OPENCODE_ROWS || "[]"))
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
