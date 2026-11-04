# Porting assets (images and file attachments)

**Status: ported.** Pasting or dropping an **image** writes it into the
graph's `assets/` folder and links it relatively. **File attachments**
(PDFs, docs, archives) take the same path: paste or drop inserts a plain
`[name](assets/…)` link (meowdown's `onFilePaste`, prosekit/meowdown#190),
an **Attach file…** command (palette + File menu) is the keyboard path,
clicking an `assets/` link opens the file through the OS, and files over
~25 MB get a non-blocking status-line warning about git-history cost. One
deviation from the plan below: dropped files stream over **chunked
raw-binary IPC** instead of arriving as OS paths (see "Finder drops").

## What v1 did

- **Entry points.** Drag-and-drop and paste in the editor
  (`image-extension.ts`, `copy-paste-extension.ts` in reflect-editor), plus
  an `uploadImages` command.
- **Two node types.** Images were resizable inline nodes (spinner, `settled`
  flag, retry-on-error). Every other type (80+ MIME types) became an
  **attachment card**: type badge, filename, size, download icon, progress
  bar.
- **Pipeline.** Client-side encryption (`@team-reflect/file-crypto`) →
  Cloudflare Worker → `reflect-assets.app` CDN under `users/{uid}/{id}`.
  Three automatic retries ("Error uploading file. Please try again and
  ensure you are online."), an unload warning ("Files are currently
  uploading."), and background re-upload on reconnect.
- **Limits.** 50 MB per file ("File is too large. 50mb is the max allowed
  size."); no storage quota; no garbage collection (orphans lived forever).
- **Export quirk.** Attachments exported to markdown as `[name](url)`;
  images didn't export at all.

## What changes in v2, and why

There is no upload. An asset is a **local file write** into `assets/`, so
the lifecycle apparatus (encryption, CDN, progress, retries, settled flags,
background re-upload, unload warnings) has nothing to attach to. What
remains is what users touch: drop a file on a note and get a working link.
Backup rides git, and references are plain relative markdown, which fixes
v1's export quirk.

## What v2 already has (images)

- meowdown's image extension handles paste/drop and calls the host's
  `onImagePaste`, which returns the markdown `src`.
- `apps/desktop/src/editor/use-asset-persistence.ts` names files
  `pasted-<timestamp>-<random>.<ext>` under `assets/`, writes through the
  traversal-guarded `asset_write` command pinned to the graph generation,
  resolves them through the async `reflect-asset://` protocol (file reads
  stay off the webview UI thread), and opens them in the OS viewer. Save
  failures surface on the pane.
- Plan 20 gives every image and **PDF** under `assets/` an AI description
  file, so PDFs were already first-class everywhere except intake.

## How attachments will work

### Editor side (meowdown)

A non-image file flows to a new host callback (`onFilePaste`, mirroring
`onImagePaste`) and is inserted as a plain link,
`[Q3 report.pdf](assets/q3-report.pdf)`, at the caret or drop position.
Multi-file drops insert one link per line (`![](…)` for images, `[…](…)`
otherwise). Rendering needs nothing new: it's a link. A richer chip (size,
type badge, like v1's card) is a later cosmetic and must stay a *view* of
the plain link, never a different serialization.

### Host side (reflect-open)

- **Naming.** Images keep `pasted-…` (screenshots have no meaningful name).
  Attachments keep their **original filename** (it is the link text),
  sanitized to the readable-filename rules, with `-2`-style suffixes on
  collision.
- **Finder drops stream, they don't buffer.** The plan assumed Tauri's
  native drag-drop event would supply OS paths, but it only fires with
  `dragDropEnabled: true`, which is deliberately **false** (it is
  window-global and kills the HTML5 drops the chat composer and editor
  use). So drops stay HTML5 `File`s, and bytes cross IPC as **chunked raw
  binary bodies** (4 MB, no base64, no JSON) via
  `asset_upload_begin`/`_append`/`_commit`, staged under `.reflect/tmp/`
  (excluded from indexing/sync) and renamed into `assets/` on commit.
  Webview memory holds one chunk, never the file. `asset_import(sourcePath,
  …)` serves sources with real paths (the **Attach file…** picker), copying
  file-to-file under the same guards. Collision suffixes are resolved in
  Rust at write time (`persist_noclobber`), so concurrent intakes never
  clobber.
- **Size is a warning, not a wall.** Every large binary lives in git
  history forever, and GitHub rejects files over 100 MB. Above ~25 MB, a
  non-blocking status-line warning appears after the save lands. Never a
  modal (the drop already said what the user wants); v1's "50mb is the
  max" alert is not ported. (A confirm-dialog was built and removed as an
  unnecessary interruption.)
- **No type policing.** v1 accepted effectively everything; v2 does too.
  Nothing executes an asset; links open through the OS.

## v1 → v2 mapping

| v1                                              | v2                                                 |
| ----------------------------------------------- | -------------------------------------------------- |
| Encrypted upload → Cloudflare → CDN URL         | Local write into `assets/`, relative link          |
| Image node with `settled`/spinner/retry         | Plain `![](assets/…)`; a write either lands or errors — no pending state |
| Attachment card (badge, size, progress)         | Plain `[name](assets/…)` link; chip view later     |
| 50 MB hard cap                                  | Soft warning tied to git-host reality              |
| Retries, background upload, unload warning      | Not applicable — no network                        |
| Orphaned uploads invisible on a server          | Orphans are visible files in `assets/`             |
| Images absent from markdown export              | Markdown is the source of truth                    |

## Explicitly not ported

- The upload lifecycle (encryption, CDN, progress, retries, pending
  states): removed by architecture, not deferred.
- `reflect-assets://` URL rewriting and signed download proxying.
- v1's attachment download flow: "open" and "reveal in Finder" replace it.

## Open questions

- **Orphan report.** Deleting a link leaves the file (same as v1). A
  palette command listing unreferenced `assets/` files, with explicit
  delete, fits the files-first ethos. *Decided: follow-up, not part of
  this work* (a first cut was built and removed as a superfluous surface;
  the index `assets` projection makes it a set difference against
  `dir_list`).
- **Paste of a copied Finder file** (the clipboard carries a file
  reference, not bytes): verify what the macOS Tauri webview exposes. If it
  is a `File` with bytes, `onFilePaste` already handles it; if not, a
  pasteboard peek + `asset_import` is the follow-up.
- **Inline PDF preview** (v1 had none): out of scope.
