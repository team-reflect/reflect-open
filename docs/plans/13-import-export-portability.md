# Plan 13 — Import / Export / Portability

> **Status (2026-06-14):** Closed by product decision. We are **not** building a
> dedicated import/export surface. The portability contract is the graph itself:
> ordinary Markdown and attachment files wherever they live, plus a rebuildable
> `.reflect/` index that can be deleted at any time.

## Decision

Markdown is good enough.

The original plan called for previewed Markdown/Obsidian import plus Markdown, JSON,
and HTML ZIP export. It added product and maintenance surface without improving the
core promise: the user's data is already plain files they can copy, back up, edit, zip,
inspect in GitHub, or open in another Markdown tool.

Reflect V1 exports now emit V2's graph-compatible Markdown shape, so there is no V1
import path: users open or copy the exported folder. Opening an existing Markdown folder
adopts it in place; it is not an import and does not rearrange files.

## Portability Contract

- The graph folder is the export. Copy or zip it directly.
- Markdown can live at the root or in visible nested folders; adopted paths stay intact.
  Discovery excludes hidden trees, `assets/`/`audio-memos/`, dependency directories
  (`node_modules` and friends, anything with a `CACHEDIR.TAG`), and paths matched by
  the vault's `.gitignore` or `.reflectignore`. The scan reports a skipped count so an
  excluded file is always explainable.
- Reflect-created notes go to `notes/`, dailies to `daily/`, pasted files to `assets/`;
  these defaults do not constrain files created by other tools.
- `.reflect/` is outside the contract: a rebuildable projection, except documented
  durable local tables such as `chat_*`.
- Frontmatter carries minimal metadata (stable IDs, aliases, `private`, `pinned`,
  capture provenance).
- Backlinks, tags, daily dates, attachments, and readable filenames stay useful outside
  Reflect because they are encoded in the files.

## Attachments and Embeds in an Opened Vault

Attachment references resolve the way CommonMark and Obsidian read them
(`packages/core/src/graph/attachment-resolution.ts`):

- A Markdown destination resolves from the note's folder first, then the vault root.
  Reflect's own `![](assets/…)` links are root-relative, which is also the answer before
  the attachment catalog loads, so Reflect-written images never wait on it. A bare
  filename that matches neither is found by name anywhere (Obsidian's "shortest path").
- `![[photo.png]]` is root-relative when it names a folder; otherwise beside the note,
  then root, then by name. Name ties go to the file beside the note, then the
  shallowest. Images render inline, other attachments as file pills.
- When the catalog has not loaded, the editor's URL request returns a promise, so the
  first render already shows the right file.
- Links to local attachments render as file pills and open in the OS default app.
- The resolver only returns a spelling the index records for that reference, so the
  asset privacy gate always sees the note that displays a file. A bare name is stored
  bare and matches every file with that name, so name lookups are covered too.

**Note embeds are not transcluded.** `![[Deep Work]]` renders as a link chip, like
`[[Deep Work]]`, and counts as a backlink; the Markdown is left as written so Obsidian
still transcludes it. Transclusion stays out of scope because: it brings a second
note's content into the editor (needs editing and round-trip rules); it competes with
the editor as a surface; and a public note transcluding a private one would render
private content where AI features act on the public note.

## Non-Goals

- No Markdown ZIP, JSON, or HTML export.
- No Obsidian/folder import workflow; existing vaults open directly.
- No importer framework for Evernote, Roam, Notion, Readwise, Kindle, etc.
- No export-to-import round-trip suite beyond the normal parser, writer, and index
  rebuild guarantees.

## What Remains

Keep the graph contract boring and durable. Reflect-owned migrations should target the
export shape at the source, not add import surfaces here. Future migration tools are
case-by-case and should not reopen a general import/export area unless the
portability premise changes.

Acceptance: a user can close Reflect, copy their graph folder, and still have their
notes and assets in normal Markdown files.
