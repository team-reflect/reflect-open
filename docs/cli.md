# The `reflect` CLI

A small, self-contained management CLI over a Reflect graph. It reads and
atomically mutates the graph's markdown files directly, while opening
`.reflect/index.sqlite` strictly read-only. No running desktop app is required.
When the app is running its watcher indexes file changes; otherwise the next
open reconciles them.

```
reflect today              # print today's daily note
reflect today --path       # its absolute path (works before the file exists)
reflect search <query>     # ranked full-text search over the index
reflect list               # list current public notes from disk
reflect show <note>        # print a note by date, path, title, or alias
reflect path <note>        # resolve a note to its absolute path
reflect open <note>        # open a note in the app (reflect:// deep link)
reflect backlinks <note>   # list incoming wiki links
reflect tasks              # list indexed tasks
reflect tags               # list indexed tag facets
reflect create <title>     # create a note
reflect append <note> ...  # append markdown
reflect task <text>        # append a task to today's daily note
reflect write <note> ...   # replace complete markdown source
reflect move <note> <path> # move a note
reflect delete <note>      # move a note to recoverable trash
reflect restore <trash>    # restore a deleted note
```

Built from `apps/cli` (`cargo build -p reflect-cli`); bundled with the desktop
app as a Tauri sidecar (macOS: `Reflect.app/Contents/MacOS/reflect`, Linux
`.deb`: `/usr/bin/reflect`). For local development:
`cargo install --path apps/cli`.

## Graph resolution

First match wins:

1. `--graph <path>` — must contain a `.reflect/` directory.
2. `$REFLECT_GRAPH` — same requirement.
3. The nearest ancestor of the current directory containing `.reflect/`
   (git-style walk-up).

There is deliberately no fallback to the desktop app's recent-graphs config:
the CLI stays deterministic for scripts and agents.

## Privacy

Notes with `private: true` frontmatter are **invisible and immutable through
the CLI** — no content, no paths, no search hits, no mutations — and there is
no flag that overrides this. Every read and existing-note mutation checks the
resolved file's current frontmatter, never just an index row, so a stale index
cannot leak or mutate a just-flagged note.

## Mutation safety

- Existing-note commands accept `--expect-hash`. Obtain the SHA-256 hash from
  `reflect show <note> --json`, then pass it to `append`, `task`, `write`,
  `move`, or `delete`. A mismatch exits `5`; re-read and reconcile the note.
- Writes stage under `.reflect/tmp/` and atomically replace or create the
  markdown file. New destinations never overwrite an existing file.
- Writable paths are restricted to `.md` files under `daily/`, `notes/`, or
  `templates/`; path traversal and symlink escapes are rejected.
- `delete` moves the source to `.reflect/trash/` and returns the restore path.
- The CLI never writes `.reflect/index.sqlite`; it remains a rebuildable
  projection owned by the desktop app.

## Output contract

- **stdout carries only data** (note content, paths, or JSON); all warnings
  and errors go to stderr.
- `--json` emits the stable shapes below — they are the agent/scripting
  contract and are locked by tests (`apps/cli/tests/cli.rs`).

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | runtime error (no graph, IO/SQL failure) |
| 2 | usage error |
| 3 | note not found, or note is private |
| 4 | index missing or unusable for an index-backed command |
| 5 | write conflict (hash mismatch or destination collision) |

## Commands

### `reflect today [--path] [--json]`

Prints today's daily note (`daily/YYYY-MM-DD.md`, local timezone). File-only —
works with no index. A missing daily is exit `3`; with `--path` the would-be
path is printed even before the file exists (dailies are created lazily, so
this is how editors/scripts create them).

```jsonc
// reflect today --json
{
  "date": "2026-06-11",
  "path": "daily/2026-06-11.md",
  "absolutePath": "/…/graph/daily/2026-06-11.md",
  "title": "2026-06-11",
  "content": "…",
  "hash": "e3b0c442…"
}
// reflect today --path --json adds "exists" and omits title/content:
{ "date": "…", "path": "…", "absolutePath": "…", "exists": false }
```

### `reflect search <query> [--limit N] [--json]`

Search over note titles and bodies, ranked like the app: exact, prefix, and
per-term title matches lead, followed by title-boosted bm25 matches. Title
terms match at word starts (`car` finds `Car log`, never `Oscar party`);
terms in scripts written without spaces (Japanese, Chinese, Korean, Thai, …)
match anywhere in the title, since FTS alone cannot see inside their
uninterrupted title runs. Body matches include snippets. Terms are matched
literally (FTS5 operators in the query have no special meaning); a title-only
JSON result has an empty snippet and score `0`. Requires the index: if
`.reflect/index.sqlite` is missing the exit code is `4` — open the graph in
Reflect to build it; the CLI never runs the indexer. If files on disk diverge
from the index (checked by mtime, then content hash), a staleness warning goes
to stderr and `"stale": true` is set — results still return.

```jsonc
// reflect search "meeting notes" --json
{
  "query": "meeting notes",
  "stale": false,
  "results": [
    { "path": "notes/standup.md", "title": "Standup", "snippet": "…meeting notes…", "score": -1.94 }
  ]
}
```

### `reflect list [--kind all|note|daily|template] [--limit N] [--json]`

Lists current public markdown files directly from disk, newest first. It does
not require the index. JSON rows include `path`, `absolutePath`, `title`,
`kind`, `mtime`, and `hash`.

### `reflect show <note> [--json]`

Resolves `<note>` and prints the raw markdown. Resolution order:

1. A calendar-valid `YYYY-MM-DD` → that daily note.
2. An explicit path (graph-relative like `notes/foo.md`, or absolute inside
   the graph).
3. A title match (case-insensitive, trimmed).
4. An alias match (from `aliases:` frontmatter, or a v1 subject-alias
   segment of a `//` title like `Charlotte MacCaw // Mum`).

Works with or without the index — when the index is missing, titles/aliases
are derived by scanning the files. Ambiguous matches resolve to the first path
alphabetically and list the others on stderr.

```jsonc
// reflect show "Project X" --json   ("date" is null for non-dailies)
{ "date": null, "path": "notes/project-x.md", "absolutePath": "…", "title": "Project X", "content": "…", "hash": "e3b0c442…" }
```

### `reflect path <note> [--json]`

Same resolution, but prints only the absolute path — for piping into editors
and tools (`$EDITOR "$(reflect path 'Project X')"`). A `YYYY-MM-DD` argument
prints the would-be daily path even before the file exists.

```jsonc
// reflect path 2099-01-01 --json   ("date" only appears for dailies)
{ "date": "2099-01-01", "path": "daily/2099-01-01.md", "absolutePath": "…", "exists": false }
```

### `reflect open <note> [--print] [--json]`

Same resolution, then navigates the Reflect app there by handing the OS URL
opener the note's `reflect://` deep link ([docs/deep-links.md](deep-links.md)).
The URL prefers the most durable address the note has: the date form for
dailies (which need not exist yet — navigation creates them lazily), the
frontmatter `id` form when the note carries one (it survives renames), else
the graph-relative path form. The `open` command does not mint missing ids;
"Copy deep link" in the app does that.

The URL is always printed to stdout; `--print` skips launching the opener —
the scriptable half. Private notes are refused (exit `3`) like every other
CLI surface, before their address leaks.

```jsonc
// reflect open "Project X" --json --print   ("date" only appears for dailies)
{ "path": "notes/project-x.md", "url": "reflect://note/01hzy3…", "launched": false }
```

### `reflect backlinks <note> [--limit N] [--json]`

Lists indexed incoming wiki links to a public note. The target and every
source are rechecked from disk for privacy. Requires the index.

### `reflect tasks [--state open|done|all] [--limit N] [--json]`

Lists the indexed task projection from public, non-template notes. JSON rows
include note path/title, marker offset, text, raw source, checked state, due
date, and heading breadcrumbs. Requires the index.

### `reflect tags [--json]`

Lists indexed tag facets and public-note occurrence counts. Requires the
index and rechecks source privacy from disk.

### `reflect create <title> [--body TEXT|--stdin] [--path PATH] [--json]`

Creates a note with generated ULID frontmatter and an H1 title. The default
path is `notes/<title-slug>.md`; collisions claim `-2`, `-3`, and so on. An
explicit path can target `notes/`, `daily/`, or `templates/` and never replaces
an existing file.

### `reflect append <note> (--text TEXT|--stdin) [--expect-hash HASH] [--json]`

Appends a markdown block with one blank line of separation. A missing daily
date is created lazily; other missing notes fail.

### `reflect task <text> [--note NOTE] [--due YYYY-MM-DD] [--expect-hash HASH] [--json]`

Appends Reflect's round task syntax (`+ [ ] text`) to today's daily note by
default. `--note` selects another public note. `--due` appends a daily wiki
link such as `[[2026-07-20]]`.

### `reflect write <note> (--content TEXT|--stdin) [--expect-hash HASH] [--json]`

Atomically replaces the note's complete markdown source. Use stdin for
multiline content and guard the write with the hash returned by `show --json`.

### `reflect move <note> <destination> [--expect-hash HASH] [--json]`

Moves a public note to an unoccupied valid note path. It does not rewrite the
note's title or inbound wiki links; callers must make those semantic edits
explicitly when needed.

### `reflect delete <note> [--expect-hash HASH] [--json]`

Moves a public note into graph-local recoverable trash. Human output is the
trash path. JSON includes the original `path`, `hash`, and `trashPath`.

### `reflect restore <trash-path> [--to PATH] [--json]`

Restores a deleted public note to its original path, or to `--to`. Existing
destinations are never replaced. Private trashed content remains inaccessible.

## For agents

These commands plus `--json` are the supported automation surface (for
example, `~/.agents` discovery workflows). The JSON field names and exit codes
above are stable; new fields may be added, existing ones will not change
meaning. Reading or mutating a private note is impossible through this surface
by design. Do not work around it by reading graph files directly.

Settings → Agents installs a per-graph agent skill
(`~/.agents/skills/reflect-<graph-slug>/SKILL.md`) that teaches coding agents
this contract: the graph's root, the bundled CLI's path, the commands, and
the privacy rules. The file carries a `reflect-managed` sha256 marker so the
app can refresh its own installs without ever overwriting a hand-edited one
(`apps/desktop/src-tauri/src/skill.rs`).

## Development notes

- The CLI deliberately duplicates a thin graph contract from
  `@reflect/core` (path conventions, fold keys, frontmatter coercions, title
  and slug derivation, SHA-256 hashing, FTS match syntax). Read-side modules
  name their TS counterpart, and the contract is pinned by the shared parity
  corpus in [`fixtures/parity/`](../fixtures/parity/README.md): TS generates
  `expected.json` from the real core pipeline, the Rust tests assert against it,
  so neither side can change without the other following in the same PR.
- The sidecar is staged by `apps/desktop/scripts/build-sidecar.mjs` into
  `apps/desktop/src-tauri/binaries/` (gitignored), which Tauri's
  `bundle.externalBin` (desktop platform overlay configs) picks up. tauri-build
  requires that file to exist before the desktop crate compiles — `pnpm tauri
  dev`/`build` stage it automatically; before a bare `cargo build/test
  --workspace`, run `pnpm --filter @reflect/desktop sidecar` once.
