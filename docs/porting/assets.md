# Porting assets (images and file attachments)

**Status: ported.** Pasting or dropping an **image** into a v2 note writes
it into the graph's `assets/` folder and links it relatively. Arbitrary
**file attachments** (PDFs, docs, archives) now take the same trip: paste
or drop inserts a plain `[name](assets/…)` link (meowdown's `onFilePaste`,
prosekit/meowdown#190), an **Attach file…** command (palette + File menu)
covers the keyboard-native path, clicking an `assets/` link opens the file
through the OS, and files over ~25 MB get a non-blocking status-line
warning about the git-history cost after they land. One deviation from the plan below: dropped files stream
over **chunked raw-binary IPC** rather than arriving as OS paths — see
"Finder drops" for why.

## What v1 did

Uploading was a genuine *upload*, with all the machinery that implies:

- **Entry points.** Drag-and-drop and clipboard paste in the editor
  (`image-extension.ts`, `copy-paste-extension.ts` in reflect-editor),
  plus a programmatic `uploadImages` command.
- **Two node types.** Images became resizable inline nodes (spinner while
  uploading, `settled` flag, retry-on-error). Every other file type — the
  MIME map covered 80+ — became an **attachment card**: file-type badge,
  filename, size, download icon, and a progress bar.
- **Pipeline.** Client-side encryption (`@team-reflect/file-crypto`) →
  Cloudflare Worker → `reflect-assets.app` CDN, under `users/{uid}/{id}`.
  Three automatic retries ("Error uploading file. Please try again and
  ensure you are online."), an unload warning ("Files are currently
  uploading."), and background re-upload on reconnect.
- **Limits.** 50 MB per file ("File is too large. 50mb is the max allowed
  size."); no plan-based storage quota; no garbage collection — orphaned
  uploads lived forever.
- **Export quirk.** Attachments exported to markdown as `[name](url)`;
  images didn't export at all.

## What changes in v2, and why

There is no upload. An asset is a **local file write** into `assets/`,
so the entire lifecycle apparatus — encryption, CDN, progress bars,
retries, settled flags, background re-upload, unload warnings — has
nothing to attach to and is not ported. What remains is exactly the part
users touch: *drop a file on a note and get a working link*. Backup rides
git like everything else, and both image and attachment references are
plain relative markdown, which fixes v1's export quirk: in v2 the markdown
**is** the note.

## What v2 already has (images)

- meowdown's image extension handles paste and drop of image files and
  calls the host's `onImagePaste`; the host returns the markdown `src`.
- reflect-open persists them
  (`apps/desktop/src/editor/use-image-persistence.ts`): named
  `pasted-<timestamp>-<random>.<ext>` under `assets/`, written through the
  traversal-guarded `asset_write` command, pinned to the graph generation,
  resolved for display through the Tauri asset protocol, and openable in
  the OS viewer. Save failures surface on the pane.
- Plan 20 gives every image (and, notably, **PDF**) under `assets/` an AI
  description file — PDFs are already first-class citizens of the asset
  pipeline everywhere *except* the way in.

## How attachments will work

### Editor side (meowdown)

Generalize the paste/drop pipeline past `filterImageFiles`: a file that
isn't an image flows to a new host callback (`onFilePaste`, mirroring
`onImagePaste`) and is inserted as a plain markdown link —
`[Q3 report.pdf](assets/q3-report.pdf)` — at the caret or drop position.
Multi-file drops insert one link per line (images as `![](…)`, everything
else as `[…](…)`, in one drop). Rendering needs nothing new: it's a link;
`link-click` and round-trip fidelity already handle it. A richer chip
(size, type badge, à la v1's card) is a later cosmetic, and must stay a
*view* of the plain link, never a different serialization.

### Host side (reflect-open)

- **Naming.** Images keep the `pasted-…` scheme (screenshots have no
  meaningful name). Attachments keep their **original filename** —
  it's the visible link text — sanitized to the graph's readable-filename
  rules, with `-2`-style suffixes on collision.
- **Finder drops stream, they don't buffer.** The plan above assumed
  Tauri's native drag-drop event would supply real OS paths — but that
  event only fires with `dragDropEnabled: true`, which is deliberately
  **false** (it's window-global and kills the HTML5 drops the chat
  composer and editor target on). So drops stay HTML5 `File`s (no OS
  path exists in the webview) and the fix targets the transport instead:
  bytes cross the IPC as **chunked raw binary bodies** (4 MB chunks, no
  base64, no JSON) via `asset_upload_begin`/`_append`/`_commit`, staged
  under `.reflect/tmp/` (excluded from indexing/sync) and renamed into
  `assets/` on commit — webview memory holds one chunk, never the file.
  `asset_import(sourcePath, …)` exists as planned for sources that *do*
  have real paths — the **Attach file…** file-picker command — copying
  file-to-file under the same traversal/generation guards. Collision
  suffixes (`-2`, `-3`, …) are resolved in Rust at write time
  (`persist_noclobber`), so two concurrent intakes can never clobber.
- **Size is a warning, not a wall.** It's the user's disk, but git backup
  is the quiet constraint: every large binary lives in history forever,
  and GitHub hard-rejects files over 100 MB. Above a threshold (~25 MB),
  a non-blocking status-line warning carries that context after the save
  lands — never a modal (the drop already said what the user wants), and
  v1's flat "50mb is the max" alert is not ported. (A confirm-dialog cut
  was built and removed as an unnecessary interruption.)
- **No type policing.** v1 accepted effectively everything; v2 does too.
  Nothing executes an asset — links open through the OS.

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

- The entire upload lifecycle (encryption, CDN, progress, retries,
  settled/pending states) — removed by architecture, not deferred.
- `reflect-assets://` URL rewriting and signed download proxying.
- v1's attachment download flow — "download" is meaningless for a file
  already on disk; "open" and "reveal in Finder" replace it.

## Open questions

- **Orphan report.** Deleting a link leaves the file (v1 behaved the same,
  invisibly). A palette command listing unreferenced `assets/` files —
  with delete as an explicit choice — fits the files-first ethos.
  *Decided: follow-up, not part of this work* (a first cut was built and
  removed as a superfluous surface; the index `assets` projection makes
  the query a set difference against `dir_list` when it's wanted).
- **Paste-of-copied-file** from Finder (clipboard carries a file
  reference, not bytes) — worth verifying what the Tauri webview exposes
  on macOS; if it surfaces as a `File` with bytes it already works via
  `onFilePaste`; if not, a pasteboard peek + `asset_import` is the
  follow-up.
- **Inline PDF preview** (v1 had none; Plan 20 descriptions may be enough
  context) — explicitly out of scope here.
