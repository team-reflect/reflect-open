# Plan 21 — iCloud Drive Sync (macOS + iOS)

**Goal:** iCloud Drive becomes Reflect's primary multi-device sync: the graph lives in
the app's iCloud container, files flow between macOS and iOS with no Reflect
infrastructure, and **conflicts never surface as mystery duplicates**. Reflect resolves
what it can safely resolve itself (identical content, non-overlapping edits via
three-way merge, append-union for daily notes, key-wise frontmatter); anything it
can't, it materializes **inside the note as the same labeled conflict markers Git sync
already uses** — one conflict surface, one `has_conflict` projection, one review UI,
regardless of which backend produced the conflict.

**Depends on:** Plan 12 (conflict markers, `has_conflict`, protected open, the review
notice), Plan 19 (iOS target), Plan 02/04 (storage + index). **Supersedes:** the
"file-sync providers are unsupported for sync by design" decision in Plan 12 and the
[overview guardrails](00-overview.md) — iCloud is promoted from non-goal to the main
consumer sync path; Git remotes remain fully supported as the power-user/backup path.
**Status:** in progress. Phase 0 items 1–3 are in flight (PR #501: cross-platform
exclusions, temp staging, placeholder handling). The **iOS leg of Phase 1** landed
ahead of the macOS move-in flow (PR #505): CloudDocuments entitlements +
`NSUbiquitousContainers`, container discovery off the main thread
(`src-tauri/src/icloud.rs`, `mobile_storage`), iCloud-first mobile onboarding with
the persisted `mobileStorage` kind, container-unavailable parking (never a silent
empty graph), and — as an interim stand-in for the Phase 2 `NSMetadataQuery`
module — a foreground refresh that nudges placeholder downloads
(`icloud_download_pending`) and re-reconciles the index on app resume
(`src/mobile/use-icloud-refresh.ts`). Fresh iOS graphs are created at
`<container>/Documents/Notes/` per contract 1; on-device verification
(entitlement registration, exclusion behavior, Mac↔iPhone round trip) is the
release gate. Remaining: Phase 0 spikes 4–6, desktop move-in/migration
(rest of Phase 1), Phases 2–4.

**Explicitly not in scope:** AI-assisted conflict resolution (deferred enhancement —
the ladder below is designed to hand it a ready-made `base/local/remote`, see
*Deferred*); a rich side-by-side diff viewer (markers + the existing notice are the V1
surface); Dropbox/Google Drive adapters; Windows/Android; CloudKit record sync;
collaboration/shared graphs.

## Where we stand

**What already exists (and is reused unchanged):**

- **The whole downstream conflict pipeline.** The Git merge materializes conflicts
  into the note as standard markers with product labels
  (`git/merge.rs` — `<<<<<<< this device` / `>>>>>>> other device`), the indexer
  projects `has_conflict` via `detectConflictMarkers`
  (`packages/core/src/markdown/conflict-markers.ts`), conflicted notes open
  protected (markers don't survive the editor round-trip), and
  `sync-conflict-notice.tsx` resolves via `resolveConflictMarkers`
  (ours/theirs/both). iCloud plugs into the *front* of this; nothing downstream
  changes shape.
- **`.reflect/` is already local-only on macOS.** `fs/io.rs::bootstrap` sets
  `NSURLUbiquitousItemIsExcludedFromSyncKey` + `NSURLIsExcludedFromBackupKey` and
  provider-ignore xattrs on `.reflect/`. The SQLite-in-a-synced-folder hazard is
  solved — on macOS. The function is a `cfg(target_os = "macos")` no-op on iOS.
- **Editor-side safety.** `note-session` already parks external changes against a
  dirty buffer as a conflict, pauses saves, and suppresses write echoes. iCloud
  events enter through the same `externalChanged()` seam the watcher uses.
- **A change-event contract.** Desktop: the `notify` watcher emits `index:changed`
  batches (`watcher.rs`). Mobile: **no watcher exists** (`watcher_mobile.rs` is a
  stub); only the app's own writes echo. The iCloud detection module is therefore
  not an add-on on iOS — it *is* the external-change watcher there.

**What iCloud actually does (this drives the whole design):**

- **Edit conflicts are not duplicate files.** When two devices edit the same file
  apart, iCloud picks a current version and stashes the losers as unresolved
  `NSFileVersion` conflict versions — with content, modification date, and saving
  device name — and expects the app to resolve them
  ([TN2336](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)).
  Unhandled, the user silently sees whichever version "won" — effectively
  last-writer-wins with the loser hidden in a version store. That is the default we
  must not ship.
- **Creation collisions do produce duplicates** (`2026-07-04 2.md`). Because daily
  notes have deterministic names, *two devices creating today's note offline is the
  single most common conflict Reflect will see* — it needs a first-class rule, not
  an edge case.
- **Eviction produces placeholders.** Optimize Storage replaces `notes/foo.md` with
  a `.foo.md.icloud` stub. To today's watcher and scanner that is indistinguishable
  from deletion.
- Detection is via `NSMetadataQuery` (conflict, upload/download state per item);
  version access via `NSFileVersion`; safe I/O via `NSFileCoordinator`.

## Design contracts

### 1. The graph lives in the ubiquity container

Both apps share one iCloud container (`iCloud.<bundle-id>`); the graph root is
`<container>/Documents/<graph-name>/`. This is mandatory on iOS and the reliable
`NSMetadataQuery` scope on macOS. A graph the user manually placed under
`~/Library/Mobile Documents/com~apple~CloudDocs/` gets the same conflict handling
best-effort (the `NSFileVersion` APIs work on any iCloud path), but setup steers
toward the container. Enabling iCloud sync is an explicit, reversible **move**
(coordinated copy → verify byte counts → swap the graph pointer → leave the original
as a renamed local backup until the user confirms).

### 2. One conflict representation: labeled markers, deterministic bytes

All unresolved conflicts become in-note marker blocks in the exact Plan 12 grammar
(`<<<<<<< <label>` / `=======` / `>>>>>>> <label>`), so detection, protection, and
resolution reuse verbatim. Two iCloud-specific refinements:

- **Truthful labels.** Labels are the versions' device names from
  `NSFileVersion.localizedNameOfSavingComputer` (fallback: `this device` /
  `other device` when unavailable). `detectConflictMarkers` already accepts any
  label; the notice gains a small label parser so buttons read "Keep *Alex's
  MacBook Pro*" instead of assuming sides.
- **Deterministic side order.** Both devices may resolve the same conflict
  concurrently (each sees itself as current — a documented iCloud behavior). Sides
  are ordered by `(modificationDate, contentHash)`, **not** by local/remote, so two
  devices independently produce byte-identical output and the conflict converges
  instead of ping-ponging. `resolveConflictMarkers`'s `ours`/`theirs` becomes
  "first/second block", which the label-aware notice presents honestly.

### 3. The resolution ladder

Runs in Rust, per conflicted note, first match wins. Steps 1–4 auto-resolve
silently; step 5 flags for review. **Before any resolution write, every losing
version's full content is archived** to `.reflect/conflict-archive/<path>/<timestamp>-<device>.md`
(local-only, pruned by age/count) — resolution must never be the only copy-holder.

1. **Identical / whitespace-only** → keep current, mark versions resolved.
2. **Three-way merge with the shadow base** (contract 4) → clean merge auto-applies.
   Engine: prefer the already-vendored libgit2 xdiff (`git2` 0.21 exposes
   `merge_file_from_index`; a Phase 0 spike proves buffer-level use without a repo —
   fallback is the small pure-Rust `diffy` crate). Output must be byte-deterministic.
3. **Structural rules** where line merge is too blunt:
   - *Frontmatter*: merge key-wise (pin state, flags); same-key different-value
     falls through to step 5 for that note.
   - *Daily-note append-union*: when both versions share a common prefix and
     diverge only by appended blocks (the dominant real case), keep the prefix and
     both appended block sets, deduplicated by exact block match, ordered by
     version timestamp. Also the rule for **creation collisions**: merge
     `2026-07-04 2.md` into the canonical file (union; both seeded from the same
     template/bullet, so the common-prefix shape holds), archive, delete the
     duplicate.
4. **Binary assets** → keep-both using the existing `name (conflict).ext`
   convention from `git/merge.rs::conflict_copy_path`.
5. **Overlapping text edits** → marker block (contract 2), `has_conflict`, protected
   open, "Needs review" — the user resolves in the existing notice, or by editing
   the markers out. This is the floor: *never* silent last-writer-wins, *never* a
   `note 2.md` left behind.

Only after the resolved content is durably written: set `resolved = true` on the
conflict versions and `removeOtherVersionsOfItem`. Edit-vs-delete keeps the edited
version (Plan 12 policy). A note whose open session is dirty is skipped — the
session's conflict-park handles it, and the ladder retries after flush.

### 4. The shadow base

Three-way merge needs a common ancestor iCloud doesn't provide. Reflect keeps one:
`.reflect/sync-base/<note-path>` — a copy of the note at its last known *synced*
state. The update rule is what makes it a true ancestor approximation — the base
advances **only** when:

- an external change is ingested cleanly (base := that content),
- a conflict resolution lands (base := merged content — both devices converge on it),
- a graph is adopted into iCloud sync (base := current content).

**Never on local saves** — advancing the base past content the other device hasn't
seen would make diff3 treat our own additions as already-merged and drop them.
A stale base is safe (both sides carry the same early edits → diff3 sees identical
changes → clean); a *missing* base degrades that note to two-way (step 5 markers) —
so the store is self-healing and losing `.reflect/` costs merge quality, not data.
Renames (Plan 17 moves files on settled titles) move the base file through the same
rename seam; a miss is again just a degraded merge.

### 5. Coexistence with Git sync, `.reflect/`, and eviction

- **`.git/` never syncs through iCloud.** Bootstrap applies the same exclusion
  treatment as `.reflect/` to `.git/` whenever it exists. Two devices' object
  stores merging file-by-file is repo corruption; this also protects users who
  *today* put a Git-backed graph inside iCloud Drive. Consequence: Git history
  becomes per-device under iCloud.
- **Remote Git sync and iCloud sync are mutually exclusive per graph.** Two
  independent merge machines over the same files would fight (and per-device `.git`
  histories pushing one remote would non-FF forever). Enabling iCloud sync
  disconnects a configured Git remote (with an explanatory prompt); local
  checkpoint commits remain allowed and useful for recovery.
- **`.reflect/` exclusion goes cross-platform.** `mark_reflect_dir_local_only`
  widens from `cfg(target_os = "macos")` to Apple targets; the
  `ubiquitousItemIsExcludedFromSync` resource key exists on iOS. Verified inside
  the container by a Phase 0 spike on both platforms.
- **Eviction ≠ deletion.** `tracked_relpath` (watcher) and `collect_files` (scan)
  learn the `.name.ext.icloud` placeholder mapping: a placeholder is an *upsert of
  a not-downloaded note* (indexed from its last-known content, or queued for
  download), never a remove. Opening or indexing a placeholder triggers
  `startDownloadingUbiquitousItem` and waits with UI state. A mass-remove guard
  refuses to apply a batch that would delete a large fraction of the graph without
  corroboration (files truly absent *and* no placeholder *and* not mid-download).
- **Temp files move out of synced dirs.** `atomic_write_bytes` currently creates
  its temp file next to the target — inside a synced folder, so crashes strand
  `.tmpXXXXXX` litter that replicates to every device. Temps move to
  `.reflect/tmp/` (same volume — rename stays atomic; the bootstrap sweep already
  reclaims strands), and writes into an iCloud graph go through an
  `NSFileCoordinator` coordinated-write wrapper.

### 6. Detection module (and the iOS watcher role)

A new platform-gated `icloud/` Rust module (objc2, following the
`contacts.rs`/`calendar.rs` pattern: dedicated thread, never the main loop; the
metadata query needs a run-loop thread like the EventKit change observer):

- **macOS:** `NSMetadataQuery` over the graph scope watching
  `NSMetadataUbiquitousItemHasUnresolvedConflictsKey` + upload/download state.
  Conflict hits feed the ladder; file events are deduped against the `notify`
  watcher (which still sees iCloud's writes as plain FS events — content-hash
  gating in the indexer already makes double delivery idempotent).
- **iOS:** the same query is the **sole external-change source** — it emits the
  standard `index:changed` batches (replacing the stub watcher) *and* feeds the
  ladder. Foreground-only, matching the existing mobile sync lifecycle: initial
  gather on launch/foreground, live updates while active, stop on background.
- **Status:** query state maps into the existing plain-language sync status
  (Synced / Syncing / Offline / Needs review) through the same precedence rules the
  mobile status line already uses.

## Phases

**Phase 0 — Foundations & spikes** (each lands alone; several fix live hazards
before any iCloud feature ships):

1. `.reflect/` exclusion on iOS + `.git/` exclusion everywhere (immediate
   protection for users with graphs already in iCloud Drive).
2. Temp files → `.reflect/tmp/`.
3. Placeholder/eviction handling in watcher + scan + mass-remove guard (unit-tested
   against synthetic `.icloud` names; also improves Dropbox-folder behavior today).
4. **Spike — entitlements & signing:** iCloud Documents container for a Developer
   ID–signed macOS app + the iOS target; provisioning profiles through the existing
   env-var signing/notarization pipeline and CI. This is the release-blocking
   unknown; do it first.
5. **Spike — objc2 surface:** `NSMetadataQuery` on a run-loop thread,
   `NSFileVersion` list/resolve/remove, coordinated write, and
   `ubiquitousItemIsExcludedFromSync` inside the container, both platforms.
6. **Spike — merge engine:** buffer-level three-way merge via vendored libgit2
   without a `Repository`; decide git2 vs `diffy`; prove byte-determinism.

**Phase 1 — Container & migration.** Container discovery (off-main-thread first
call), "Sync with iCloud" in settings + onboarding: move-in flow per contract 1,
Git-remote mutual-exclusion prompt, iOS adoption of the container root (migration
from the local Documents root), graph pointer/recents updates, container-unavailable
handling (iCloud signed out → clear blocking state, never a silent empty graph).

**Phase 2 — Detection + the safe floor.** The `icloud/` module on both platforms;
iOS `index:changed` emission; conflict handling with ladder steps **1, 4, 5 only**
(identical, binary keep-both, markers) + archive + version cleanup + duplicate-file
(creation-collision) detection funneling into the same path; status mapping; the
label-aware notice. *Ship gate: two-device edit conflict ends as one reviewable
marked-up note; nothing is ever lost; daily-note double-creation collapses to one
file (with markers when bodies overlap).*

**Phase 3 — The merge ladder.** Shadow-base store + update rule + rename
integration; three-way engine wired as step 2; structural rules (frontmatter
key-wise, append-union) as step 3; deterministic ordering; convergence property
tests (simulated two-device resolution → identical bytes; base-staleness cases;
append-union corpus from real daily-note shapes). *Ship gate: the common cases —
append-only divergence, disjoint edits, double-created daily notes — resolve with no
user interaction.*

**Phase 4 — Hardening & docs.** Two-device manual matrix (Mac+iPhone: offline edits
both sides, double-create, eviction under low storage, rename races, kill-app
mid-save, signed-out iCloud); archive pruning; docs (`docs/icloud-sync.md` user
contract, overview/guardrail updates, Plan 12/16 pointers, `libraries.md`).

## Failure cases

| Case | Behavior |
| --- | --- |
| Both devices resolve the same conflict concurrently | Deterministic ladder → byte-identical result on both; iCloud sees agreement (or a trivially-identical conflict → step 1). |
| Conflict arrives while the note is open + dirty | Session parks it (existing `note-session` behavior); ladder skips and retries after flush. |
| Both devices online, simultaneous save | Each sees its own version current + the other as a conflict version; ladder runs on each; determinism converges them. |
| Merge ladder itself crashes mid-resolution | Archive was written first; versions still unresolved → retried next cycle. Worst case: user sees the conflict version notice later, loses nothing. |
| Evicted note opened / indexed | Download-on-demand + explicit loading state; timeout → error state, never a blank overwrite. |
| iCloud signed out / container missing | Blocking "iCloud unavailable" state with the local-copy escape hatch; no writes routed anywhere surprising. |
| Shadow base missing/stale | Degrades to two-way (markers) / slightly more conflicts — never data loss. |
| `private: true` note conflicts | Identical handling — everything in this plan is local. (The flag only gates the deferred AI enhancement.) |
| Placeholder mistaken for deletion | Can't: placeholder mapping + mass-remove guard; a true external deletion still propagates (edit-vs-delete keeps edits). |

## Deferred

- **AI-assisted resolution** (the original ladder step 6): when step 5 would fire
  and a BYOK provider is configured, propose a merged note from
  `base/local/remote` for review in the notice — the sync-strategy doc's
  `SyncConflict`/`ResolutionPlan` flow. The ladder already produces exactly that
  triple; this bolts on without reshaping anything. `private: true` hard-blocks it.
- Rich diff viewer replacing raw markers in the protected view.
- Dropbox/Drive adapters (duplicate-file detection + the same ladder).
- Background (non-foreground) sync on iOS; Android/Windows equivalents.
