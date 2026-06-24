# Plan 13 — Import / Export / Portability

> **Status (2026-06-14):** Closed by product decision. We are **not** building a
> dedicated import/export portability surface. Reflect's portability contract is the
> graph itself: ordinary markdown files in `daily/`, `notes/`, and `assets/`, plus a
> rebuildable `.reflect/` index that can be deleted at any time.

## Decision

Markdown is good enough.

The original plan called for previewed Markdown/Obsidian import plus Markdown, JSON,
and HTML ZIP export. That work is no longer planned. It adds product and maintenance
surface without improving the core promise: the user's durable data is already plain
files they can copy, back up, edit, zip, inspect in GitHub, or open in another markdown
tool.

Reflect V1 exports are now emitted in Reflect V2's graph-compatible markdown shape, so
there is no dedicated Reflect V1 import path. Users migrate by opening or copying the
exported graph folder directly.

## Portability Contract

- The graph folder is the export. Copy or zip the folder directly.
- `daily/`, `notes/`, and `assets/` contain the user-owned durable data.
- `.reflect/` is excluded from the portability contract. It is a rebuildable local
  projection, except for explicitly documented durable local tables such as `chat_*`.
- Markdown frontmatter carries minimal metadata such as stable IDs, aliases, `private`,
  `pinned`, and capture provenance.
- Backlinks, tags, daily-note dates, attachments, and readable filenames remain useful
  outside Reflect because they are encoded in the files themselves.

## Non-Goals

- No Markdown ZIP export button.
- No JSON export.
- No HTML export.
- No Obsidian/folder import workflow.
- No generalized importer framework for Evernote, Roam, Notion, Readwise, Kindle, or
  other apps.
- No export-to-import round-trip test suite beyond the normal markdown parser, writer,
  and index rebuild guarantees.

## What Remains

Keep the markdown graph contract boring and durable. Reflect-owned migration work should
target the export shape at the source rather than adding one-off import surfaces here.

Future migration tools can be considered case-by-case, but they should not reopen a
general import/export product area unless the portability premise changes.

The acceptance criterion for this plan is now simple: a user can close Reflect, copy
their graph folder, and still have their notes and assets in normal markdown files.
