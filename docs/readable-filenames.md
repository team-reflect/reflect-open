# Readable filenames & note identity

Regular notes live at `notes/<slug>.md`, where the slug derives from the
note's title: a note titled "Meeting Notes" is `notes/meeting-notes.md`, and
when the title changes, the file follows. The graph reads as plain markdown
in Finder, on GitHub, in Obsidian — no opaque ULID names (Plan 17).

Three rules make the whole system hang together:

1. **The filename is a projection of the title.** The title lives in content
   (the first H1, or frontmatter `title:`); the slug is derived from it, never
   edited directly. There is no "rename file" UI — retitle the note and the
   filename follows.
2. **The frontmatter `id` is the durable identity.** Every note Reflect
   creates carries `id: <lowercase ulid>`. Filenames change; the id never
   does. It's what lets the index recognize a file that moved while Reflect
   wasn't looking, and what exposes sync forks.
3. **Wiki links carry titles, not paths.** `[[Meeting Notes]]` resolves at
   query time against the index's title/alias keys, so a file rename breaks
   zero links by construction. This is the keystone: everything below is
   cheap *because* links never reference filenames.

Daily notes are untouched by all of this — `daily/YYYY-MM-DD.md` is already
the readable contract, and their date labels never rename.

## The slug

`slugForTitle` (`packages/core/src/markdown/slug.ts`): NFC-normalize,
lowercase, keep letters/numbers, collapse whitespace/`_`/`-` runs to a single
`-`, drop everything else, trim edge dashes, cap at 60 code points. Never
empty (`untitled`), never a Windows reserved device name (`con` → `con-note`).
CJK and other scripts pass through untransliterated: `日本語ノート` keeps its
characters.

Two properties are load-bearing:

- **Lowercase-only output** makes APFS/NTFS case-insensitivity and git
  case-sensitivity agree by construction — `Meeting.md` vs `meeting.md` can
  never fight across platforms because Reflect only ever writes the latter.
- **The 60-point cap** serves readability and the filesystem at once: 60
  worst-case 4-byte letters stays inside the 255-byte basename limit with
  room for `notes/`, `.md`, and a collision suffix.

The rules are **frozen** by a golden corpus in `slug.test.ts`. Changing any
output is a rename storm across every graph — a failure there is a deliberate
breaking-change gate, not a test to update casually.

Collisions take a numeric suffix: `meeting.md`, then `meeting-2.md`, `-3`, ….
The probe (`packages/core/src/indexing/note-paths.ts`) checks the index *and*
the disk (`note_exists`), so a file the watcher hasn't indexed yet can't be
clobbered. A note's own path always counts as available — a note never
collides with itself, and a note already at `meeting-2.md` doesn't "tighten"
to `meeting.md` when it frees up.

## Birth: how notes get their names

- **Created with a title** (the `[[` autocomplete's create row, clicking an
  unresolved link): the file is born at its slug path with `id:` frontmatter
  and the title as H1 (`apps/desktop/src/lib/create-note.ts`).
- **Created untitled** (⌘N): no title exists yet, so the file gets a ULID
  placeholder name (`untitledNotePath`). The lazy-create seed — a selectable
  "Untitled" H1 plus a fresh `id:` — reaches disk only when the user actually
  types. When the first title settles, a **birth** fires (a rename with
  `from: null`): no links to rewrite, no alias to record, the file just sheds
  its placeholder for the slug.

## Rename: filenames follow settled titles

Only settled, in-app title changes move files. Sync pulls, external edits,
reconciles, and rebuilds never rename a file — that single rule makes move
loops with external tools impossible.

The settled-title tracker (`apps/desktop/src/editor/title-rename.ts`, Plan
07b) watches saves and fires after 5 seconds of quiet, or immediately on
blur/pane teardown/quit. The rename coordinator
(`apps/desktop/src/editor/rename-coordinator.ts`) then runs three phases, each
failing independently with an honest report (`rename-failure.ts`):

1. **Rewrite** inbound `[[old title]]` links across the graph.
2. **Alias** the old title onto the note (`alias-placement.ts`), so anything
   the rewrite missed still resolves.
3. **Move** the file onto the new title's slug (`move-note.ts`).

The move itself (`moveNoteCarryingSession`) is ordering-as-mechanism: flush
the session, retarget it to the new path (so any later save writes the new
home), re-key the open-documents registry (identity-guarded — it can never
grab another pane's document), then call `note_move_indexed`. On the Rust
side (`db/mod.rs`, `db/write.rs`) the projection rows move in one
transaction — pinned state, conflict flags, FTS, and crucially
`embedding_chunks` all ride along, so **a rename never re-embeds** (BYOK
re-embeds cost the user money) — the transaction commits, and only then does
the file rename (`fs::move_note_file`). A failed rename compensates with a
reverse row-move; every failure path converges.

**An occupied destination always refuses** — db row or disk file, one rule at
both layers. Nothing is deleted or overwritten; the rename reports failed and
the filename drifts until the next settled rename retries. (Deliberate
simplification, 2026-06-11: the only way a destination gets occupied mid-move
is a race whose window is one IPC round-trip behind a 5-second save-quiet
gate.) Drift is cosmetic by design: resolution never reads filenames.

After a successful move, the app follows the file:

- `emitNoteMoved` (`apps/desktop/src/lib/note-moves.ts`) announces it.
- The router rewrites every history entry pointing at the old path — the
  current route follows without an arrival, and back/forward can never land
  on a dead path (`apps/desktop/src/routing/router.tsx`).
- The pane **adopts** its retargeted session instead of recreating it: the
  editor is keyed on `sessionEpoch`, not the path, so the cursor, selection,
  and undo history survive the rename
  (`apps/desktop/src/editor/document-binding.ts` owns the
  create/adopt/teardown/hand-off protocol; `use-note-document.ts` is a thin
  React adapter over it).

The watcher's echo of the move (`remove(old)` + `upsert(new)`) is benign by
construction: the rows moved before the file did, so the remove finds nothing
and the upsert re-applies an identical projection.

## External renames heal by id

Rename a file in Finder, Obsidian, or via a sync pull, and Reflect's index
recognizes it: an indexed row whose file vanished plus an unindexed file
carrying the same frontmatter `id` is a *move*, not a delete+create
(`packages/core/src/indexing/move-detection.ts`, `move-healing.ts`). The rows
migrate (`index_move`), embeddings survive, and `followHealedMove` carries any
open session and the route to the new path — exactly as if the rename
happened in-app. Both observation points heal: the open-time reconcile
(orphans ↔ arrivals) and the live watcher (same-batch remove+upsert pairs).

Limits, all deliberate:

- **Ambiguous ids never pair.** Two files claiming one id (or one id claimed
  by two vanished rows) could wire one note's history to another's file —
  those surface as sync forks instead.
- **Files without ids can't heal** — anything created outside Reflect falls
  back to delete+create, which always converges.
- **Split watcher batches degrade** to delete+create: the orphan row is gone
  before the arrival shows. In practice the debouncer groups rename halves.

## Sync

A rename reaches git as delete+add. The merge semantics (pinned by two-device
tests in `src-tauri/src/git/tests.rs`):

- **Rename on one device + edit on another** converges cleanly — libgit2's
  default rename detection lands the edit in the moved file.
- **Same title created on two devices offline** collides on one path and
  surfaces through the existing conflict-marker flow (this was impossible
  under ULID names; accepted as rare and recoverable).
- **The same note retitled differently on two devices** forks into two files
  sharing one id. Nothing wedges, both files survive, and the fork surfaces
  in **Settings → Backup** ("renamed differently on two devices…") via
  `getDuplicateNoteIds`. Repair is the user's call — merge by hand, delete
  the copy you don't want.

## What deliberately doesn't exist

- **No ULID→slug migration.** Pre-launch there are no legacy graphs; a
  ULID-named note converts through the birth/rename path the next time it's
  titled.
- **No "rename file" UI** — the filename is derived, full stop.
- **No id-based routes** — routes and the index stay path-keyed; the id is
  for reconciliation and fork detection.
- **No md-style link rewriting** — `[text](notes/foo.md)` links (an
  external-tool shape; Reflect writes wiki links) dangle after a rename. The
  `links` table records `kind = 'md'`, so a later pass can find them.
- A note with explicit frontmatter `title:` can't be retitled from the editor
  (the H1 isn't its title), so its filename only changes via external renames
  — which heal by id like any other.

## Code map

| Concern | Where |
|---|---|
| Slug rules (frozen) | `packages/core/src/markdown/slug.ts` + golden corpus in `slug.test.ts` |
| Collision probe / rename target | `packages/core/src/indexing/note-paths.ts` |
| Creation (titled + ⌘N seed/path) | `apps/desktop/src/lib/create-note.ts` |
| Settled-title detection, births | `apps/desktop/src/editor/title-rename.ts` |
| Rename orchestration | `apps/desktop/src/editor/rename-coordinator.ts` (+ `alias-placement.ts`, `rename-failure.ts`) |
| The move (session-carrying + healed) | `apps/desktop/src/editor/move-note.ts` |
| Pane lifecycle (create/adopt/hand-off) | `apps/desktop/src/editor/document-binding.ts` |
| Move announcements → router/panes | `apps/desktop/src/lib/note-moves.ts`, `apps/desktop/src/routing/router.tsx` |
| Row move + fs rename (Rust) | `apps/desktop/src-tauri/src/db/mod.rs` (`note_move_indexed`, `index_move`), `db/write.rs` (`move_note`), `fs/mod.rs` (`move_note_file`) |
| Id-based healing | `packages/core/src/indexing/move-detection.ts`, `move-healing.ts`, wired in `indexer.ts` + `live.ts` → `followHealedMove` |
| Sync fork surface | `apps/desktop/src/components/settings/sync-fork-notice.tsx`, `getDuplicateNoteIds` in `packages/core/src/indexing/queries.ts` |
| Merge-shape tests | `apps/desktop/src-tauri/src/git/tests.rs` (rename matrix) |

Plan and decision history: [docs/plans/17-readable-filenames.md](plans/17-readable-filenames.md).
