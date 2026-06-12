# Plan 17 — Readable filenames

> As-built documentation: [docs/readable-filenames.md](../readable-filenames.md)
> — how the shipped system works, with a code map. This file is the plan and
> decision history.

**Goal:** Finish the note-identity contract Plan 02 specified but the first wave
shortcut: regular notes get **title-derived filenames** (`notes/meeting-notes.md`,
not `notes/01kts4w0cb3n39zb99ycs48fj1.md`), a **frontmatter `id`** (ULID) written at
creation as the durable identity, and **file renames that follow settled title
changes**.

**Depends on:** Plan 02 (`note_move`, atomic fs IO, path-traversal guard), Plan 03
(frontmatter model — `id` is already in the schema), Plan 04 (index, watcher,
hash-skip reconcile), Plan 07b (settled-title tracker, link rewrite, the
session-owns-frontmatter channel), Plan 12 (git engine — rename/merge semantics,
checkpoints).
**Unlocks:** a graph that reads as plain markdown on GitHub/Finder/Obsidian — the
"boring vault durability" promise of the product vision, kept at the filename level.

**Libraries:** none new. The slugger is hand-rolled in `@reflect/core`
(`markdown/slug.ts`): the constraint set (Windows reserved names, byte caps,
case folding, CJK preservation) is bespoke, small, and property-testable;
off-the-shelf slugifiers transliterate or strip non-Latin scripts.

## Why now / what changed

Plan 02 recorded the intent — *"Filenames are stable and human-readable; renames are
handled in Plan 07"* — with identity carried by a frontmatter ULID. The first wave
shipped the inverse shortcut: the ULID became the filename, `id:` was never written
(the `notes.id` column and the parser→indexer mapping exist and run; the value is
always null), and Plan 07b deferred filename sync (*"Filenames stay put in the first
wave… `note_move` filename-sync can join later"*). This plan is that join point.

Two properties of the shipped architecture make it cheap now:

- **Wiki links carry titles, not paths.** `[[Project X]]` resolves at query time via
  `title_key`/`alias_key` (Plan 03/04). A file rename breaks zero wiki links by
  construction.
- **The settled-title machinery exists.** The 07b tracker already debounces title
  edits, distinguishes births from renames, guards collisions, and rewrites inbound
  links. The file move is one more action on an event we already detect.

## Scope

**In:** slug derivation (one TS source of truth), slug filenames at creation,
frontmatter `id` written at creation, rename-on-settled-title file moves, a
transactional index move (Rust) that preserves pinned state/conflict flags/
embeddings, live editor+route retarget, sync-matrix
tests (rename+edit, rename+rename, add/add, case-only retitle).

**Out:** user-editable filenames decoupled from titles (the filename is always
*derived*; no "rename file" UI), folders/subdirectories (association over
hierarchy), id-based routes (routes stay path-based), rewriting inbound
**markdown-style** `[text](notes/foo.md)` links on rename (the app writes wiki
links; path-style links are an external-tool edge — recorded as a risk),
automatic same-`id` duplicate repair after sync (detection ships, repair is a
later surface), daily notes (untouched in every respect — `daily/YYYY-MM-DD.md`
*is* the readable contract).

## Delivery split

- **17a — slugs at birth** (steps 1–3): the slugger; `createNoteWithTitle` (the
  `[[` autocomplete create path — title is known) writes `notes/<slug>.md` with
  `id:` frontmatter; ⌘N keeps a ULID path at birth (the file is created on the
  first keystroke, before any title exists) but also gets `id:`. No rename
  machinery; pure win, shippable alone.
- **17b — filenames follow titles** (steps 4–7): the transactional move, watcher
  reconciliation-by-construction, editor/route retarget, tracker integration
  (births *and* renames move the file). The bulk of the work.
- ~~**17c — migration**~~ — *removed 2026-06-11 (Alex: pre-launch, no
  backwards compatibility). A ULID→slug migration only converts pre-Plan-17
  graphs, which won't exist at launch; dev graphs heal note-by-note through
  the birth/rename path the next time a note is titled.*

## Steps

1. **Slugger** (`@reflect/core` `markdown/slug.ts`). `slugForTitle(title): string`:
   NFC-normalize → lowercase (Unicode-aware) → keep `\p{L}\p{N}`, map whitespace
   and separator runs to single `-` → strip everything else (covers `/ \ : * ? "
   < > |`, control chars) → trim leading/trailing `-`/`.` → cap at 60 code
   points (one cap covers readability *and* the 255-byte basename limit:
   60 × 4-byte astral letters stays inside it) → if empty, `untitled` → if a
   Windows reserved device name
   (`con`, `prn`, `aux`, `nul`, `com1-9`, `lpt1-9`), append `-note`. Lowercase-only
   output is load-bearing: it makes APFS/NTFS case-insensitivity and git
   case-sensitivity agree by construction. CJK and other scripts pass through
   (no transliteration). Property tests: idempotent, never empty, never reserved,
   byte-safe on all three OSes.

2. **Collision-free target picker.** `availableNotePath(slug, generation)`: try
   `notes/<slug>.md`, then `<slug>-2.md`, `-3`, … checking the index *and* disk
   (`note_exists`) so unindexed files can't be clobbered. Collisions are expected
   to be rare; the suffix is the whole policy (no id-tails on every file — don't
   tax the common case for the rare one).

3. **Identity at creation — and identity that works.** `createNoteWithTitle`
   writes `notes/<slug>.md` with frontmatter `id: <lowercase ulid>` + `# Title`.
   `newNoteRoute` (⌘N) keeps its ULID birth path (no title exists yet) and the
   lazy-create seed gains the same `id:` frontmatter. The parser→indexer→`notes.id`
   pipeline already exists and runs; this step starts feeding it. Add a
   non-unique index on `notes.id`, **duplicate-id detection** (two paths
   claiming one id = a sync fork; surfaced beside `Needs review` in the
   backup section, repair deferred), and — the payoff — **id-based move
   healing**: the open-time reconcile and the live watcher pair a vanished
   row with an appeared file carrying the same id and *move* the rows
   (`index_move`) instead of delete+create, so external renames (Finder,
   Obsidian, sync pulls) stop dropping embeddings and derived state.
   Ambiguous ids never pair — guessing could wire one note's history to
   another's file; the duplicate-id surface reports those instead.

4. **Transactional move** (Rust, new command `note_move_indexed(from, to,
   generation)`). One SQLite transaction + fs rename that: moves the `notes` row
   to the new path and migrates every path-keyed dependent — `note_text`, `links.
   source_path`, `tags`, `aliases`, `assets`, `embedding_chunks.note_path`, the
   FTS row — then renames the file (atomic-write discipline from Plan 02), then
   emits the index-changed event. Embedding vectors survive because the rows move
   and `content_hash` is unchanged; a rename must never trigger a re-embed (BYOK
   re-embeds cost the user money). The bare Plan-02 `note_move` is **removed**:
   a file rename without its projection is exactly the bug class this command
   exists to prevent, and nothing else may rename tracked notes.

5. **Reconciliation by construction** (no watcher special-casing). The fs rename
   echoes back as `remove(old)` + `upsert(new)`. Because the DB moved *first*:
   `remove(old)` deletes rows that no longer exist (no-op) and `upsert(new)`
   re-applies an identical projection over the moved row (idempotent; the
   live path doesn't hash-skip, but embedding chunks live outside `apply_note`
   so vectors survive). Verify with an integration test
   rather than suppression logic — the ordering *is* the mechanism. The
   reconcile/index path itself **never renames files**: only in-app settled
   titles move files, so external editors, sync pulls, and rebuilds can never
   feedback-loop.

6. **Editor + route retarget.** On move, the open session swaps its path in place
   (same content, no reload — the 07b session already owns the disk channel),
   the router replaces the current route's path, and TanStack Query keys for the
   old path are invalidated. The save pipeline must be quiesced across the swap
   (move fires from the settled-title tracker, which already waits for save
   quiet) so an autosave can never resurrect the old path.

7. **Tracker integration.** Extend the 07b settled-title pipeline: after the
   existing collision guard and link rewrite, compute `slugForTitle(newTitle)`;
   if it differs from the current basename, pick a target (step 2) and call
   `note_move_indexed`. **Births move too**: a ⌘N note's first settled title
   replaces the ULID basename (no link rewrite — nothing links to a title that
   never existed; the 07b birth/rename distinction already encodes this). Case-
   or punctuation-only retitles often produce the same slug — same-slug means
   no move, by design. The 07b parked-conflict gate applies unchanged. Notes
   with an explicit frontmatter `title:` keep 07b's recorded edge (no editor
   rename surface yet) and therefore never move from the editor.

8. ~~**Migration** (17c)~~ — removed; see the delivery split note. Notes
   born before slugs landed convert through step 7's birth/rename path the
   next time they're titled.

9. **Tests.** Slugger properties (idempotence, emptiness, reserved names, byte
   caps, CJK passthrough, case folding); collision picker (index+disk, suffix
   sequence); transactional move preserves pinned/conflict/embeddings and FTS;
   watcher echo is a no-op; birth rename on first title; settled rename moves +
   rewrites + aliases in one flow; editor survives a move mid-session; the sync
   matrix (below).

## Key decisions / contracts

- **Filename = derived artifact, title = source of truth.** The slug is a
  *projection* of the title, like the index is a projection of the files. Users
  never edit filenames in-app; external filename edits are tolerated (the
  indexer keys by path and re-indexes) but never "corrected" by Reflect.
- **Pure slug, suffix only on collision** (decided 2026-06-11): `meeting.md`,
  `meeting-2.md` — not `meeting-01kts4w0.md`. Readability is the point; the
  id-tail variant taxes every filename to ease a rare case that `id:`
  frontmatter already disambiguates.
- **Lowercase-only slugs** are the cross-platform safety mechanism (APFS/NTFS
  case-insensitivity, git case-sensitivity, NFC normalization for macOS/Linux
  agreement). The slugger is the *only* author of note filenames in-app.
- **`id:` frontmatter becomes real** (Plan 02's original contract): written at
  creation, lowercase ULID, indexed into the existing
  `notes.id` column. Identity for *reconciliation and repair*; **path remains
  the index PK and the route key** — no id-based routing in this plan.
- **Only settled in-app title changes move files.** Sync pulls, external edits,
  reconciles, and rebuilds never rename a file. This single rule prevents move
  loops with external tools and other devices. The complement: when something
  *else* renames a file, Reflect **heals by id** — the reconcile and the
  watcher recognize the moved identity and migrate the projection rows rather
  than treating it as delete+create.
- **A rename is never a re-embed.** The transactional move carries
  `embedding_chunks` rows; `content_hash` semantics are untouched.
- **Sync stance:** a rename reaches git as delete+add; libgit2's default merge
  rename detection (`FIND_RENAMES`) absorbs rename-vs-edit. The two genuinely
  new conflict shapes are accepted and surfaced, not auto-repaired: **add/add**
  (same title created on two devices offline → both-edited markers in one file,
  existing conflict surface) and **rename/rename** (one note forks into two
  paths → duplicate-`id` flag, deterministic link resolution keeps links
  stable). Repair UI is a later surface.

## Acceptance criteria

- Creating a note from `[[` autocomplete yields `notes/<slug>.md` with `id:`
  frontmatter; ⌘N notes adopt their slug on first settled title.
- Retitling a note (settled) renames the file, rewrites inbound links, preserves
  the alias, keeps pinned state, conflict flags, and embeddings — verified by
  test, no re-embed call observed.
- The watcher echo of a move causes zero index churn (hash-skip observed).
- An open editor survives its own note's rename without reload or content loss;
  the route and backlinks panel follow.
- Sync matrix passes: rename+edit merges clean; add/add and rename/rename
  surface as review states, nothing wedges, no data loss.
- `pnpm check` + targeted vitest/cargo tests pass.

## Risks

- **The move/save race** (editor autosave straddling the rename) is the
  highest-severity correctness risk — a lost race recreates the old file and
  forks the note. Mitigate: the move only fires from the settled-title tracker
  (already save-quiet), the session path-swap is synchronous before any
  subsequent save, and an occupied destination — db row or disk file — simply
  **refuses the move** (decided 2026-06-11, replacing an earlier same-id
  adoption heuristic: the race window is sub-millisecond after a 5s quiet
  period, and a refused rename costs only cosmetic filename drift that the
  next settled rename retries).
- **Add/add collisions are new** (impossible under ULID filenames). Two offline
  devices creating "Meeting" produce one conflicted file merging unrelated
  notes. Accepted: rare, surfaced by the existing conflict UI, recoverable from
  git history; `id:` divergence makes a future auto-split tractable. Recorded
  trade-off, not an oversight.
- **Filename drift** remains possible where renames can't fire (explicit
  `title:` frontmatter notes, refused moves, external retitles). Drift is
  cosmetic by design — resolution never reads filenames — but ⌘K's title
  display must never fall back to the basename for a drifted note (it shows the
  indexed title; the ULID-garbage failure mode from the non-daily-notes review
  must not regress).
- **Path-style inbound links** (`[x](notes/foo.md)`, Obsidian-import artifacts)
  dangle after a rename. Out of scope to rewrite; the `links` table records
  `kind = 'md'`, so a later pass can find and fix them. Import (Plan 13) should
  prefer converting these to wiki links at ingest.
- **Slugger edge regressions** (RTL scripts, combining marks, byte-boundary
  truncation). Mitigate with property tests + a frozen golden-corpus test so
  slugs never change silently across releases — a slug change is a rename
  storm.
