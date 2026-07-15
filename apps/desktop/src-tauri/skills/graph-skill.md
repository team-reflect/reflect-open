---
name: {{SKILL_NAME}}
description: Read, search, create, edit, move, delete, restore, and open notes and tasks in the user's "{{GRAPH_NAME}}" Reflect graph via the `reflect` CLI. Use whenever the user asks about their Reflect notes, daily notes, journal, tasks, backlinks, tags, note history, or requests any change to this graph.
---

# Reflect graph: {{GRAPH_NAME}}

Reflect is a local-first, markdown-backed note-taking app. This skill targets
one graph (a folder of notes):

    {{GRAPH_ROOT}}

Use the `reflect` CLI rather than scanning or editing files directly. It
resolves titles, aliases, and daily dates, performs atomic writes, detects
concurrent edits with hashes, and enforces the privacy contract.

## The CLI

Prefer the binary bundled with this Reflect build so every documented command
is available:

    {{CLI_PATH}}

Use `reflect` from PATH only when that bundled path is unavailable. Always
target the graph explicitly so calls stay deterministic:

    "{{CLI_PATH}}" --graph "{{GRAPH_ROOT}}" <command>

or export `REFLECT_GRAPH="{{GRAPH_ROOT}}"` for a sequence of calls and invoke
the same bundled binary. In the command reference below, `reflect` means this
bundled binary with the graph targeted as above.

## Git history

On desktop, every graph is also a Git repository at its root. Reflect
initializes or adopts that repo when the graph opens; even graphs with no
backup remote keep local history through a commit-only sync loop. There may be
no `origin`, but `.git` history is available.

Use the CLI for current note lookup, privacy filtering, path resolution, and
mutations. Use Git only when the user asks for history, diffs, recovery, or
past states:

    git -C "{{GRAPH_ROOT}}" log --oneline -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" diff <rev> -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" show <rev>:<graph-relative-path>

Do not use Git history to bypass privacy. Never read or expose a private note's
current or historical content through direct files, Git, or another tool.

## Read commands

    reflect today              # print today's daily note
    reflect today --path       # its absolute path (works before the file exists)
    reflect search <query>     # ranked full-text search over the graph
    reflect list               # recent public notes (`--kind`, `--limit`)
    reflect show <note>        # print a note by date, path, title, or alias
    reflect path <note>        # resolve a note to its absolute path
    reflect open <note>        # open the note in the Reflect app
    reflect backlinks <note>   # public notes linking to this note
    reflect tasks              # public tasks (`--state open|done|all`)
    reflect tags               # public tag facets

## Write commands

    reflect create <title> [--body TEXT|--stdin] [--path notes/x.md]
    reflect append <note> --text TEXT [--expect-hash HASH]
    reflect append <note> --stdin [--expect-hash HASH]
    reflect task <text> [--note NOTE] [--due YYYY-MM-DD] [--expect-hash HASH]
    reflect write <note> --stdin [--expect-hash HASH]
    reflect move <note> <destination> [--expect-hash HASH]
    reflect delete <note> [--expect-hash HASH]
    reflect restore <trash-path> [--to notes/x.md]

For an existing note, first run `reflect show <note> --json`, preserve its
complete `content`, and pass its `hash` as `--expect-hash`. Exit code 5 means
the note changed; re-read it and reconcile instead of overwriting. Use stdin
for multiline Markdown:

    reflect show "Project X" --json
    printf '%s' "$NEW_SOURCE" | reflect write "Project X" --stdin --expect-hash HASH

`delete` is recoverable: keep the returned `.reflect/trash/...` path and pass
it to `restore`. `move` changes the file path only; when a title/path change
also requires wiki-link rewrites, update affected source notes explicitly.

- Add `--json` to any command for stable machine-readable output — the field
  names and exit codes are the supported automation contract.
- `<note>` resolves in order: `YYYY-MM-DD` date, graph-relative path, title,
  then alias (case-insensitive).
- stdout carries only data; warnings and errors go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | runtime error (no graph, IO failure) |
| 2 | usage error |
| 3 | note not found, or note is private |
| 4 | index missing for an index-backed command — open the graph in Reflect once |
| 5 | write conflict (hash mismatch or destination collision) |

## Rules

1. **Respect privacy.** Notes with `private: true` frontmatter are invisible
   through the CLI by design — no content, no paths, no search hits. Never
   work around this through direct files, Git history, or another tool.
2. **Use guarded writes.** Prefer `--expect-hash` for every existing-note
   mutation. Never retry a conflict with an unguarded overwrite; re-read first.
3. **Respect destructive intent.** Create/append/edit when requested. Move,
   delete, restore, or bulk-change only when the user asked for that outcome.
   Never edit `.reflect/index.sqlite`; it is a rebuildable projection.
4. **Prefer search over enumeration.** `reflect search` uses the app's own
   ranked index; don't grep the whole graph when a search will do.
