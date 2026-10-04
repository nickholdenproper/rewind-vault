# rewind-vault

Archive, restore and back up [opencode](https://opencode.ai) sessions from a menu
that looks like opencode's own TUI.

`rewind` gives you one screen for the four things you actually want to do with
AI session history:

- **Start new project** — name a folder and rewind starts watching it.
- **Save a session** — export it to a plain `.json.gz` you own.
- **Load a session** — import it back and resume it exactly where it stopped.
- **Back up session database** — `VACUUM INTO` a consistent snapshot.

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
               4 archived · 12.1 MB · 1 snapshot
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
  index.json                    one row per saved session and per project
  sessions/<label>--<id>.json.gz one gzip file per session
  db/opencode-<timestamp>.db     optional database snapshots
```

Config lives outside the vault so moving or deleting the vault never orphans
your settings:

| Platform | Config file |
|---|---|
| Linux / macOS | `~/.config/rewind/config.json` (or `$XDG_CONFIG_HOME`) |
| Windows | `%USERPROFILE%\.config\rewind\config.json` |

## Projects, and saving without thinking about it

**Start new project** asks for a name and a folder, and from then on rewind
watches that folder. Sessions you start inside it are archived for you the
moment you quit opencode — no menu, no remembering to save anything:

```
Saved 2 new sessions from rewind:
  deploy-the-thing-d001     (14 msgs)
  fix-the-flaky-test-c7f2   (38 msgs)
Watching rewind — new sessions archive when you quit opencode.
```

The next time you open the menu it catches up on anything opencode recorded in
the meantime, so the vault is never more than one run behind. Each project
contributes at most 10 new sessions per run, so a busy folder cannot quietly
fill your disk, and archives are grouped under their project on the load screen.

Registering a project is not the only way in. **Save a session** still lists
the 15 most recent sessions from the database and lets you archive any of them
by hand, which is the right tool for a folder you have not registered.

If a registered folder is moved or deleted, rewind says so rather than quietly
matching nothing.

## Commands

| Command | What it does |
|---|---|
| `rewind` | The menu. `esc` drops you into plain opencode. |
| `rewind where` | Print the vault path, config path and archive count. |
| `rewind setup [folder]` | Set or change the vault location. |
| `rewind doctor` | Check node, opencode, the database and the vault. |
| `rewind history list` | Every archived session, non-interactive. |
| `rewind history save <sessionID> [name]` | Archive one session by id. |
| `rewind history import <name\|sessionID> [folder]` | Restore an archive without the menu. |
| `rewind history backup-db` | Write a database snapshot. |

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