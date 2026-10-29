# The `reflect` CLI

A small, self-contained read/discovery CLI over a Reflect graph (Plan 14). It
reads the graph's markdown files directly and opens `.reflect/index.sqlite`
strictly read-only, so no running desktop app is required. It never writes:
markdown edits are the write path, and the desktop app refreshes the index.

```
reflect today              # print today's daily note
reflect search <query>     # ranked full-text search over the index
reflect show <note>        # print a note by date, path, title, or alias
reflect path <note>        # resolve a note to its absolute path
reflect open <note>        # open a note in the app (reflect:// deep link)
```

`reflect --help` lists the flags, graph resolution order, and exit codes
(`apps/cli/src/main.rs`). Built from `apps/cli` (`cargo build -p reflect-cli`);
bundled with the desktop app as a Tauri sidecar (macOS:
`Reflect.app/Contents/MacOS/reflect`, Linux `.deb`: `/usr/bin/reflect`). For
local development: `cargo install --path apps/cli`.

## Design choices

- **No fallback to the desktop app's recent-graphs config.** The graph comes
  only from `--graph`, `$REFLECT_GRAPH`, or a `.reflect/` walk-up, so the CLI
  stays deterministic for scripts and agents.
- **Private notes are invisible.** Notes with `private: true` give no content,
  no paths, and no search hits, and no flag overrides this. `show`, `today`,
  `path`, and `open` explain on stderr and exit `3`. The check reads the
  resolved file's own frontmatter, never just the index row, so a stale index
  can't leak a just-flagged note.
- **stdout carries only data** (content, paths, or JSON). Warnings and errors
  go to stderr.
- **The CLI never runs the indexer.** `search` exits `4` without an index
  (open the graph in Reflect to build it). When files diverge from the index,
  results still return with a stderr warning and `"stale": true`.
- **Search ranks like the app.** Terms match literally (FTS5 operators have no
  meaning) at word starts, so `car` finds `Car log`, never `Oscar party`.
- **`today --path` and `path YYYY-MM-DD` print the would-be daily path** before
  the file exists. Dailies are created lazily, so this is how scripts create
  them.
- **`open` uses the most durable address**: the date for dailies, the
  frontmatter `id` when present (it survives renames), else the path
  ([docs/deep-links.md](deep-links.md)). The CLI does not mint ids; "Copy deep
  link" in the app does. `--print` prints the URL without launching the app.
- Ambiguous `show`/`path` matches resolve to the first path alphabetically and
  list the others on stderr.

## For agents

The five commands plus `--json` are the supported automation surface. The JSON
shapes are locked by `apps/cli/tests/cli.rs`. Field names and exit codes are
stable: new fields may be added, existing ones won't change meaning. Reading a
private note is not possible through this surface by design. Don't work around
it by reading graph files directly unless the user asked for that.

Settings → Agents installs a per-graph agent skill
(`~/.agents/skills/reflect-<graph-slug>/SKILL.md`) that teaches coding agents
this contract. A `reflect-managed` sha256 marker lets the app refresh its own
installs without overwriting a hand-edited one
(`apps/desktop/src-tauri/src/skill.rs`).

## Development notes

- The CLI deliberately duplicates a thin read-side contract from
  `@reflect/core` (path conventions, fold keys, frontmatter coercions, title
  derivation, SHA-256 hashing, FTS match syntax). Each Rust module names its
  TS counterpart. The shared parity corpus in
  [`fixtures/parity/`](../fixtures/parity/README.txt) pins the contract: TS
  generates `expected.json` from the real core pipeline and the Rust tests
  assert against it. Don't grow the surface.
- tauri-build requires the sidecar binary
  (`apps/desktop/src-tauri/binaries/`, gitignored) to exist before the desktop
  crate compiles. `pnpm tauri dev`/`build` stage it automatically. Before a
  bare `cargo build/test --workspace`, run `pnpm --filter @reflect/desktop
  sidecar` once.
