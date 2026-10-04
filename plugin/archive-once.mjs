#!/usr/bin/env node
/**
 * Archives a single session, then exits. This is the process the opencode plugin
 * spawns from `session.idle`.
 *
 * It is a separate process on purpose. It runs in Node rather than opencode's
 * Bun runtime, which means it can reuse lib/store.mjs as-is: the same vault
 * format, the same project matching, the same label rules. If the worker ever
 * fails it takes nothing down with it, because opencode is not waiting on it.
 *
 * Usage: node archive-once.mjs <sessionID>
 */
import { configuredVault, readConfig } from "../lib/config.mjs"
import * as store from "../lib/store.mjs"

const sessionID = process.argv[2]

async function main() {
  if (!sessionID) {
    process.stderr.write("usage: archive-once.mjs <sessionID>\n")
    return 2
  }
  store.setVault(configuredVault(await readConfig()))
  // Record the session before archiving it. "Clear all history" has to leave the
  // session the user is currently in alone, and it is the plugin -- not the
  // CLI -- that knows which one that is. This runs on every idle, so the answer
  // is always one turn stale at worst, which is the same session.
  await store.noteActiveSession(sessionID)
  // refresh: 0 on purpose. The timer needs a rate limit because it polls blind
  // every two minutes and would otherwise re-export a session that barely moved.
  // An idle event is not blind: the session demonstrably changed, so rewriting it
  // is the whole point. With 0, planAutoArchive still skips anything whose
  // timeUpdated has not moved, so a repeated idle for an unchanged session costs
  // a query and nothing more.
  await store.archiveSessionById(sessionID, { refresh: 0 })
  return 0
}

// Exit quietly whatever happens. A stack trace on stderr here would land in
// opencode's own logs and tell the user nothing useful about their own work.
main().then(
  (code) => {
    process.exitCode = typeof code === "number" ? code : 0
  },
  () => {
    process.exitCode = 0
  },
)