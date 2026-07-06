---
name: {{SKILL_NAME}}
description: Read, search, and open notes in the user's "{{GRAPH_NAME}}" Reflect graph via the `reflect` CLI. Use when the user asks about their notes, daily notes, journal, or anything they may have written down in Reflect.
---

# Reflect graph: {{GRAPH_NAME}}

Reflect is a local-first, markdown-backed note-taking app. This skill targets
one graph (a folder of notes):

    {{GRAPH_ROOT}}

Read it through the `reflect` CLI rather than scanning the files — the CLI
resolves titles, aliases, and daily dates, searches the graph's ranked index,
and enforces the privacy contract.

## The CLI

Use `reflect` from PATH when available; the app also bundles the binary at:

    {{CLI_PATH}}

Always target the graph explicitly so calls stay deterministic:

    reflect --graph "{{GRAPH_ROOT}}" <command>

or export `REFLECT_GRAPH="{{GRAPH_ROOT}}"` for a sequence of calls.

## Git history

On desktop, every graph is also a Git repository at its root. Reflect
initializes or adopts that repo when the graph opens; even graphs with no
backup remote keep local history through a commit-only sync loop. There may be
no `origin`, but `.git` history is available.

Use the CLI for current note lookup, privacy filtering, and path resolution.
Use Git only when the user asks for history, diffs, recovery, or past states:

    git -C "{{GRAPH_ROOT}}" log --oneline -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" diff <rev> -- <graph-relative-path>
    git -C "{{GRAPH_ROOT}}" show <rev>:<graph-relative-path>

Do not use Git history to bypass privacy. If a note is private, avoid reading
or exposing its current or historical content unless the user explicitly asks.

## Commands

    reflect today              # print today's daily note
    reflect today --path       # its absolute path (works before the file exists)
    reflect search <query>     # ranked full-text search over the graph
    reflect show <note>        # print a note by date, path, title, or alias
    reflect path <note>        # resolve a note to its absolute path
    reflect open <note>        # open the note in the Reflect app

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
| 4 | search index missing — open the graph in Reflect once to build it |

## Rules

1. **Respect privacy.** Notes with `private: true` frontmatter are invisible
   through the CLI by design — no content, no paths, no search hits. Never
   work around this by reading graph files directly unless the user
   explicitly asks for that.
2. **The CLI never writes.** Notes are plain markdown under the graph root
   (`daily/YYYY-MM-DD.md`, `notes/*.md`). To change a note, edit the file the
   CLI resolves (`reflect path <note>`); the running app picks the edit up.
3. **Prefer search over enumeration.** `reflect search` uses the app's own
   ranked index; don't grep the whole graph when a search will do.
