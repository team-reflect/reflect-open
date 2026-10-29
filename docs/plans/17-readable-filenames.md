# Plan 17 — Readable filenames

> As-built documentation: [docs/readable-filenames.md](../readable-filenames.md),
> with a code map. This file is the plan and decision history.

**Goal:** Finish the note-identity contract Plan 02 specified but the first wave
shortcut: regular notes get **title-derived filenames** (`notes/meeting-notes.md`, not
`notes/01kts4w0cb3n39zb99ycs48fj1.md`), a **frontmatter `id`** (ULID) written at
creation as the durable identity, and **file renames that follow settled title
changes**.

**Depends on:** Plan 02 (atomic IO, traversal guard), Plan 03 (`id` already in the
frontmatter schema), Plan 04 (index, watcher, reconcile), Plan 07b (settled-title
tracker, link rewrite, session-owned frontmatter), Plan 12 (git rename/merge semantics).
**Unlocks:** a graph that reads as plain Markdown on GitHub/Finder/Obsidian, the
product vision's "boring vault durability" at the filename level.

**Libraries:** none new. The slugger is hand-rolled in `@reflect/core`: the constraints
(Windows reserved names, byte caps, case folding, CJK preservation) are bespoke, small,
and property-testable, and off-the-shelf slugifiers transliterate or strip non-Latin
scripts.

## Why now / what changed

Plan 02 intended stable, human-readable filenames with a frontmatter ULID as identity.
The first wave shipped the inverse: the ULID became the filename, `id:` was never
written (the `notes.id` column existed but was always null), and Plan 07b deferred
filename sync. This plan is that join point. Two shipped properties make it cheap:

- **Wiki links carry titles, not paths**, resolved at query time, so a file rename
  breaks zero wiki links by construction.
- **The settled-title machinery exists:** 07b already debounces title edits, tells
  births from renames, guards collisions, and rewrites inbound links. The file move is
  one more action on an event we already detect.

## Scope

**In:** one TS slug source of truth, slug filenames at creation, `id` at creation,
rename-on-settled-title moves, a transactional index move (Rust) that preserves pinned
state, conflict flags, and embeddings, live editor+route retarget, sync-matrix tests
(rename+edit, rename+rename, add/add, case-only retitle).

**Out:** user-editable filenames (always *derived*; no "rename file" UI), folders
(association over hierarchy), id-based routes, rewriting inbound **Markdown-style**
`[text](notes/foo.md)` links on rename (the app writes wiki links; recorded as a risk),
automatic same-`id` duplicate repair after sync, daily notes (`daily/YYYY-MM-DD.md`
*is* the readable contract).

## Delivery split

- **17a, slugs at birth** (steps 1–3): the `[[` autocomplete create path (title known)
  writes `notes/<slug>.md` with `id:`. ⌘N keeps a ULID path at birth (the file is
  created on the first keystroke, before any title) but also gets `id:`. Shippable
  alone.
- **17b, filenames follow titles** (steps 4–7): transactional move, reconciliation by
  construction, editor/route retarget, tracker integration. The bulk of the work.
- ~~**17c, migration**~~: *removed 2026-06-11 (Alex: pre-launch, no backwards
  compatibility). Pre-Plan-17 graphs will not exist at launch; dev graphs heal
  note-by-note through the birth/rename path.*

## Steps

1. **Slugger** (`packages/core/src/markdown/slug.ts`). Notable choices: a 60-code-point
   cap covers readability *and* the 255-byte basename limit (60 × 4-byte letters fits);
   empty → `untitled`; Windows reserved names get `-note`. **Lowercase-only output is
   load-bearing**: it makes APFS/NTFS case-insensitivity and git case-sensitivity agree
   by construction. CJK and other scripts pass through (no transliteration). Property
   tests: idempotent, never empty, never reserved, byte-safe on all three OSes.
2. **Collision-free target:** `<slug>.md`, then `-2`, `-3`, …, checking the index *and*
   disk so unindexed files cannot be clobbered. The suffix is the whole policy: no
   id-tails on every file (do not tax the common case for the rare one).
3. **Identity at creation, and identity that works.** New notes get lowercase-ULID `id:`
   frontmatter. Add a non-unique index on `notes.id` and **duplicate-id detection** (two
   paths claiming one id = a sync fork; repair deferred. A Settings fork list was later
   removed: the app shows no fork UI). The payoff is **id-based move healing**: reconcile
   and the watcher pair a vanished row with an appeared file carrying the same id and
   *move* the rows instead of delete+create, so external renames (Finder, Obsidian, sync
   pulls) stop dropping embeddings and derived state. Ambiguous ids never pair: guessing
   could wire one note's history to another's file.
4. **Transactional move** (Rust `note_move_indexed`): one SQLite transaction moves the
   `notes` row and every path-keyed dependent (incl. FTS and embedding chunks), then the
   file is renamed, then the index-changed event fires. Vectors survive because rows move
   and `content_hash` is unchanged; a rename must never re-embed (BYOK re-embeds cost the
   user money). The bare Plan 02 `note_move` is **removed**: a file rename without its
   projection is exactly the bug class this command prevents.
5. **Reconciliation by construction** (no watcher special-casing). The rename echoes as
   `remove(old)` + `upsert(new)`. Because the DB moved *first*, `remove(old)` is a no-op
   and `upsert(new)` re-applies an identical projection (embedding chunks live outside
   that apply, so vectors survive). An integration test verifies it; the ordering *is*
   the mechanism. Reconcile/indexing **never renames files**, so external editors, sync
   pulls, and rebuilds cannot feedback-loop.
6. **Editor + route retarget.** The open session swaps its path in place (no reload),
   the router replaces the route, and old-path query keys are invalidated. Saves must be
   quiesced across the swap (the tracker already waits for save quiet) so an autosave
   can never resurrect the old path.
7. **Tracker integration.** After 07b's collision guard and link rewrite, move the file
   if the slug differs from the basename. **Births move too:** a ⌘N note's first settled
   title replaces the ULID basename (no link rewrite, since nothing links to a title that
   never existed). Same slug means no move (common for case/punctuation retitles). The
   07b parked-conflict gate applies unchanged. Notes with explicit `title:` frontmatter
   keep 07b's recorded edge and never move from the editor.
8. ~~**Migration** (17c)~~: removed; old notes convert through step 7 when next titled.
9. **Tests:** slugger properties; collision picker (index + disk); move preserves
   pinned/conflict/embeddings/FTS; watcher echo is a no-op; birth rename; settled rename
   moves + rewrites + aliases in one flow; editor survives a move; the sync matrix.

## Key decisions / contracts

- **Filename = derived artifact, title = source of truth.** The slug is a projection of
  the title, like the index is of files. External filename edits are tolerated (the
  indexer re-indexes by path) but never "corrected".
- **Pure slug, suffix only on collision** (decided 2026-06-11): `meeting.md`,
  `meeting-2.md`, not `meeting-01kts4w0.md`. Readability is the point; `id:` already
  disambiguates the rare case.
- **Lowercase-only slugs** are the cross-platform safety mechanism (case-insensitive
  filesystems, case-sensitive git, NFC for macOS/Linux agreement). The slugger is the
  *only* in-app author of note filenames.
- **`id:` frontmatter becomes real** (Plan 02's original contract), for reconciliation
  and repair. **Path remains the index PK and route key.**
- **Only settled in-app title changes move files.** Sync pulls, external edits,
  reconciles, and rebuilds never rename. This one rule prevents move loops with other
  tools and devices. The complement: when something *else* renames a file, Reflect
  **heals by id**.
- **A rename is never a re-embed.**
- **Sync stance:** a rename reaches git as delete+add; libgit2's default rename
  detection absorbs rename-vs-edit. Two new conflict shapes are surfaced, not
  auto-repaired: **add/add** (same title created offline on two devices → conflict
  markers in one file) and **rename/rename** (one note forks into two paths →
  duplicate-`id` flag; deterministic resolution keeps links stable).

## Acceptance criteria

- `[[` autocomplete creates `notes/<slug>.md` with `id:`; ⌘N notes adopt their slug on
  first settled title.
- A settled retitle renames the file, rewrites inbound links, preserves the alias,
  pinned state, conflict flags, and embeddings (no re-embed observed).
- The watcher echo of a move causes zero index churn.
- An open editor survives its own note's rename without reload or content loss; route
  and backlinks follow.
- Sync matrix: rename+edit merges clean; add/add and rename/rename surface as review
  states, nothing wedges, no data loss.

## Risks

- **Move/save race** (autosave straddling the rename) is the highest-severity risk: a
  lost race recreates the old file and forks the note. Mitigate: moves fire only from
  the save-quiet tracker, the path swap is synchronous before any later save, and an
  occupied destination (DB row or disk file) **refuses the move** (decided 2026-06-11,
  replacing a same-id adoption heuristic: the window is sub-millisecond after a 5s
  quiet period, and a refusal only costs cosmetic drift that the next rename retries).
- **Add/add collisions are new** (impossible with ULID filenames): two offline devices
  creating "Meeting" produce one conflicted file merging unrelated notes. Accepted: rare,
  surfaced by the conflict UI, recoverable from git; divergent `id:`s make a future
  auto-split tractable.
- **Filename drift** where renames cannot fire (explicit `title:`, refused moves,
  external retitles) is cosmetic, since resolution never reads filenames. But ⌘K must
  never fall back to the basename for a drifted note (the ULID-garbage failure mode
  must not regress).
- **Path-style inbound links** (`[x](notes/foo.md)`) dangle after a rename. Out of
  scope; `links` records `kind = 'md'`, so a later pass can fix them.
- **Slugger edge regressions** (RTL, combining marks, byte truncation): property tests +
  a frozen golden corpus, because a slug change is a rename storm.
