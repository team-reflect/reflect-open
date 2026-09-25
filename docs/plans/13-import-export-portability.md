# Plan 13 — Import / Export / Portability

> **Status (2026-06-14):** Closed by product decision. We are **not** building a
> dedicated import/export portability surface. Reflect's portability contract is the
> graph itself: ordinary Markdown and attachment files wherever they already live,
> plus a rebuildable `.reflect/` index that can be deleted at any time. Reflect-created
> regular notes, daily notes, and pasted files use `notes/`, `daily/`, and `assets/`.

## Decision

Markdown is good enough.

The original plan called for previewed Markdown/Obsidian import plus Markdown, JSON,
and HTML ZIP export. That work is no longer planned. It adds product and maintenance
surface without improving the core promise: the user's durable data is already plain
files they can copy, back up, edit, zip, inspect in GitHub, or open in another markdown
tool.

Reflect V1 exports are now emitted in Reflect V2's graph-compatible markdown shape, so
there is no dedicated Reflect V1 import path. Users migrate by opening or copying the
exported graph folder directly. Opening an existing Markdown folder adopts it in place;
it is not an import and does not rearrange its files.

## Portability Contract

- The graph folder is the export. Copy or zip the folder directly.
- Eligible Markdown can live at the graph root or in visible nested folders. Reflect
  keeps adopted paths intact. Hidden trees, `assets/`/`audio-memos/`, well-known
  dependency directories (`node_modules` and friends, plus anything stamped with a
  `CACHEDIR.TAG`), and paths matched by the vault's own `.gitignore` or a
  `.reflectignore` file are excluded from discovery; the scan reports a skipped
  count so an excluded file is always explainable.
- Reflect-created regular notes live in `notes/`, daily notes in `daily/`, and pasted
  files in `assets/`; those defaults do not constrain files created by other tools.
- `.reflect/` is excluded from the portability contract. It is a rebuildable local
  projection, except for explicitly documented durable local tables such as `chat_*`.
- Markdown frontmatter carries minimal metadata such as stable IDs, aliases, `private`,
  `pinned`, and capture provenance.
- Backlinks, tags, daily-note dates, attachments, and readable filenames remain useful
  outside Reflect because they are encoded in the files themselves.

## Attachments and Embeds in an Opened Vault

An adopted vault keeps its images beside its notes, so attachment references resolve
the way CommonMark and Obsidian read them (`packages/core/src/graph/attachment-resolution.ts`):

- A Markdown destination (`![alt](../attachments/photo.png)`) resolves from the note's
  own folder first, then from the vault root. Reflect's own `![](assets/…)` links are
  vault-root relative, which is also the answer before the attachment catalog has
  loaded, so Reflect-written images never wait on it. A bare filename that matches
  neither reading is found by name anywhere in the vault (Obsidian's "shortest path").
- An Obsidian embed, `![[photo.png]]`, is vault-root relative when it names a folder
  and found by name when it does not. Images render inline and other attachments render
  as file pills. Ties go to the file beside the note, then the shallowest one.
- Links to local attachments render as file pills and open in the OS default app.
- The resolver only ever returns a spelling the index records for that reference, so
  the asset privacy gate always sees the note that displays a file. A bare name is
  stored bare and matches every file with that name, so a name lookup is covered too.

**Note embeds are not transcluded.** `![[Deep Work]]` renders as a link chip to the
note, like `[[Deep Work]]`, and counts as a backlink. The Markdown is left as written,
so Obsidian still transcludes it. Transclusion stays out of scope for three reasons.
It would bring a second note's content into the editor, which needs editing and
round-trip rules. It would put another surface in competition with the editor. And a
public note that transcluded a private one would render private content where AI
features act on the public note.

## Non-Goals

- No Markdown ZIP export button.
- No JSON export.
- No HTML export.
- No Obsidian/folder import workflow. Existing Markdown vaults open directly instead.
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
