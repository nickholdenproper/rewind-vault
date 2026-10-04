# rewind-vault

Archive, restore and back up [opencode](https://opencode.ai) sessions from a menu
that looks like opencode's own TUI.

`rewind` gives you one screen for the things you actually want to do with AI
session history:

- **Load a session** — import it back and resume it exactly where it stopped.
- **Back up session database** — `VACUUM INTO` a consistent snapshot.
- **Clear all history** — erase every session opencode has recorded, plus every
  archive rewind holds.
- **Start opencode** — `esc` does the same thing from anywhere.

There is nothing to set up. You do not register projects or pick folders: rewind
archives every session opencode records, wherever it ran, so it is saved before
you think to save it.

It has **no dependencies** and talks to your existing opencode install through
its own CLI (`opencode export`, `opencode import`, `opencode db`).

## Install

opencode first, then rewind:

```sh
npm install -g opencode-ai
npm install -g rewind-vault
```

That installs two commands: `rewind` and the short alias `oc`.

Check it can see both halves:

```sh
rewind doctor
```

```
node           v22.14.0
opencode       opencode.cmd (1.18.34)
database       /home/you/.local/share/opencode/opencode.db
config         /home/you/.config/rewind/config.json
vault          /home/you/.rewind
               7 saved · 12.1 MB
```

## First run

The first time you start the menu, rewind asks where to keep the vault:

```
  Where should rewind keep your saved sessions?   enter keeps this path

  /home/you/.rewind█

  enter confirm  esc cancel
```

Press enter to accept the default, or type any folder (`~/Documents/rewind`,
`D:\Backups\rewind`, `%USERPROFILE%\.rewind` — `~`, `%VAR%` and `$VAR` are
expanded). The answer is written to your config file and every later run uses
it. Change it any time:

```sh
rewind setup            # same prompt, keeps existing archives where they are
rewind setup ~/Backups  # or pass the folder straight in
rewind where            # show the vault, config file and archive count
```

Nothing is stored on anyone else's computer and nothing is uploaded anywhere.
The vault is just a folder on your disk:

```
~/.rewind/
  index.json                    one row per saved session
  sessions/<label>--<id>.json.gz one gzip file per session
  db/opencode-<timestamp>.db     optional database snapshots
```

Config lives outside the vault so moving or deleting the vault never orphans
your settings:

| Platform | Config file |
|---|---|
| Linux / macOS | `~/.config/rewind/config.json` (or `$XDG_CONFIG_HOME`) |
| Windows | `%USERPROFILE%\.config\rewind\config.json` |

## Saving without thinking about it

rewind archives every session opencode records. There is no folder to nominate and
no project to register, so a session started anywhere — including one with no
directory recorded at all — is kept. Passes archive up to 25 new sessions each,
most recently touched first, so a busy day cannot quietly fill your disk.

### Saving the moment a turn ends

This is the part that actually protects your work, so it is worth being precise
about. The obvious design — archive when opencode exits — is the wrong one: a
power cut, a crash or a closed laptop lid means the child never exits cleanly, so
the archive step never runs and you come back to an empty vault. Waiting for
shutdown is waiting for the one event that does not arrive.

rewind saves at the boundary that *does* happen reliably: **the moment a turn
finishes**. opencode fires `session.idle` at exactly that point, when the
transcript is durably written and nothing is mid-stream. A turn is atomic, so
there is no gap to lose.

```sh
rewind plugin install
```

That writes a small plugin into `~/.config/opencode/plugins/`, which opencode
loads automatically at startup. Restart opencode and sessions save themselves.

The plugin is a trigger, not an archiver. On `session.idle` it shells out to a
Node worker that does the real save with rewind's own code, so the vault format
lives in exactly one place. Two things follow from that: the plugin cannot
corrupt an archive even if it misbehaves, and a session started with plain
`opencode` is saved too, not just one launched through `rewind`.

Because it runs inside opencode's own process, the plugin is written to be
invisible: it never prints to the terminal, never throws (an exception here
would surface as an opencode crash), and collapses bursts of events so
subagent chatter does not spawn a process per message.

### The timer backstop

rewind also refreshes the vault every two minutes while opencode runs, and once
more on exit. That is not redundant. It covers a session that ends without a
clean `session.idle` — a crash, a `kill`, an unplugged cable — and it keeps
working if the plugin is not installed. If the plugin is present, the timer
usually finds nothing to do.

An archive is also kept current rather than frozen at the moment you first quit.
If you carry on working in a session that is already saved, rewind rewrites it,
so the copy in the vault always matches the session as of the last save. Rewrites
are rate-limited to one per session every five minutes, because re-exporting a
long session is not free.

When you quit you get a summary of everything that landed:

```
Saved 2 new sessions from rewind:
  deploy-the-thing-d001     (14 msgs)
  fix-the-flaky-test-c7f2   (38 msgs)
Updated 1 session from rewind:
  long-refactor-9ab2        (412 msgs)
```

Automatic saving is the normal path. `rewind history save <sessionID> [name]`
still archives one session by hand, which is the right tool when you want a
session under a specific name.

### Clearing everything

opencode accumulates sessions nobody asked for. **Clear all history** erases them,
along with every archive rewind holds:

```sh
rewind history clear
```

It shows what is about to go first, then wants you to type `DELETE`. Close
opencode before you run it: opencode holds sessions in memory and would write
them straight back over the top, so rewind refuses while it is running.

Projects, workspaces and credentials are left alone — those are configuration,
not history. A `VACUUM INTO` snapshot is written to `db/` first, so the wipe is
reversible; delete that file too if you want the data gone.

Deleting rows does not shrink the file, so the space only comes back afterwards:
in WAL mode `VACUUM` writes into the write-ahead log and the main file gives the
pages back on the next checkpoint. rewind checkpoints, vacuums, then checkpoints
again, which is the difference between a 2.4 GB file and a 200 KB one.

Both timers are configurable, if you would rather lose less or save less often:

| Variable | Default | What it does |
|---|---|---|
| `REWIND_LIVE_INTERVAL` | `120000` | How often the vault is refreshed while opencode runs, in ms |
| `REWIND_LIVE_REFRESH` | `300000` | Minimum gap before an already-saved session is rewritten, in ms |

## Commands

| Command | What it does |
|---|---|
| `rewind` | The menu. `esc` drops you into plain opencode. |
| `rewind plugin install` | Turn on save-on-turn-end. Restart opencode after. |
| `rewind plugin status` | Whether live saving is on, and where it points. |
| `rewind plugin uninstall` | Remove it; saving falls back to the timer. |
| `rewind where` | Print the vault path, config path and archive count. |
| `rewind setup [folder]` | Set or change the vault location. |
| `rewind doctor` | Check node, opencode, the database and the vault. |
| `rewind history list` | Every archived session, non-interactive. |
| `rewind history save <sessionID> [name]` | Archive one session by id. |
| `rewind history import <name\|sessionID> [folder]` | Restore an archive without the menu. |
| `rewind history backup-db` | Write a database snapshot. |
| `rewind history clear` | Erase every opencode session and every archive. Wants `DELETE` typed. |

Anything else after `rewind` is passed straight to opencode, so `oc -s <id>` or
`oc run "fix the build"` keep working.

### Scripting

`history list`, `history save`, `history import` and `history backup-db` all
work without a TTY, which makes them usable from a cron job or a git hook:

```sh
rewind history list
rewind history backup-db
```

If no vault is configured yet they fall back to `~/.rewind` instead of
prompting, or you can pin it explicitly:

```sh
REWIND_VAULT=/mnt/backups/rewind rewind history backup-db
```

## Environment variables

| Variable | Effect |
|---|---|
| `REWIND_VAULT` | Use this vault instead of the configured one. |
| `REWIND_HOME` | Pretend `$HOME` is this (used by the tests). |
| `REWIND_CONFIG_DIR` | Put `config.json` here instead of `~/.config/rewind`. |
| `OPENCODE_BIN` | Full path to the opencode binary. |
| `OPENCODE_DB` | Full path to opencode's database file. |
| `OC_DRY_RUN` | Print the opencode command instead of running it. |
| `OC_PLAIN`, `NO_COLOR` | Disable colour. |
| `OC_COLOR` | Force `truecolor`, `256`, `16` or `never`. |
| `OC_WIDTH`, `OC_ROWS` | Pretend terminal size. |

## Keys

Menu: `↑`/`↓` or `PgUp`/`PgDn`/`Home`/`End` to move, type to filter, `enter` to
choose, `esc` for plain opencode.

Load list: `ctrl+r` renames an archive (the file on disk is renamed too),
`ctrl+d` deletes one and asks twice.

## A note on what lands on disk

Archives are **plain gzip, not encrypted**. A session can contain source code,
tool output and anything you pasted into it, so treat the vault like you treat
your git history: back it up somewhere you trust, and do not commit it.
Rewind never reads or writes your opencode `auth.json`.

External `tool-output` files a session references are not part of the export —
that is opencode's format, not something rewind can change.

## Development

```sh
npm test          # config, first-run, archive, ui and layout suites
node test/preview-menu.mjs   # render the splash with colour
node test/preview-real.mjs   # render the load list against your real vault
```

The tests drive a fake TTY and set `REWIND_HOME` / `REWIND_CONFIG_DIR` to a
temp folder, so they never touch your own vault. The archive suites point
`OPENCODE_BIN` at `test/fixtures/fake-opencode.mjs`, which answers `db` and
`export` and reproduces SQLite's byte-exact `IN (...)` matching.

## License

MIT