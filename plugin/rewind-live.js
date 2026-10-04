/**
 * rewind live-saving plugin for opencode.
 *
 * Installed into ~/.config/opencode/plugins/, which opencode loads automatically
 * at startup -- no config edit required.
 *
 * The plugin is a trigger, not an archiver. On session.idle it shells out to a
 * small Node worker that does the real save using rewind's own code. That keeps
 * the vault format and project matching in exactly one place, and means this
 * file cannot corrupt an archive even if it misbehaves.
 *
 * Two rules, both load-bearing:
 *   - Never throw. This runs inside the user's editor; an exception here would
 *     surface as an opencode crash.
 *   - Never write to stdout. opencode owns the terminal.
 */

// Both paths are baked in at install time as quoted JSON string literals.
const NODE = __REWIND_NODE__
const WORKER = __REWIND_WORKER__
const DEBOUNCE_MS = 2000

export const RewindLivePlugin = async ({ $ }) => {
  // sessionID -> when we last kicked off a save for it. A busy session emits
  // session.idle more than once in quick succession (subagents, resumed turns),
  // and each one would otherwise spawn its own process.
  const lastRun = new Map()

  return {
    event: async ({ event }) => {
      try {
        if (!event || event.type !== "session.idle") return
        const id = event.properties?.sessionID
        if (!id) return

        const now = Date.now()
        const previous = lastRun.get(id) || 0
        if (now - previous < DEBOUNCE_MS) return
        lastRun.set(id, now)
        if (lastRun.size > 200) lastRun.clear()

        // Bun's $ escapes interpolated values. .quiet() keeps the worker's
        // output out of the TUI and .nothrow() keeps a failed save from
        // surfacing as an error here.
        await $`${NODE} ${WORKER} ${id}`.quiet().nothrow()
      } catch {
        // Deliberately silent. The timer in the rewind launcher is the backstop.
      }
    },
  }
}