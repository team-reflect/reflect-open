# Plan 21 — iCloud Drive Sync (macOS + iOS)

**Goal:** iCloud Drive becomes Reflect's primary multi-device sync: the graph lives in
the app's iCloud container, files flow between macOS and iOS with no Reflect
infrastructure, and **conflicts never surface as mystery duplicates**. Reflect resolves
what it safely can (identical content, three-way merge, daily-note append-union,
key-wise frontmatter) and merges the rest at the word level. The ladder always returns
text, and the same ladder resolves git pulls and editor saves.

**Depends on:** Plan 12 (Git merge machinery), Plan 19 (iOS), Plans 02/04. **Supersedes:**
the "file-sync providers are unsupported by design" decision in Plan 12 and the
[overview](00-overview.md) guardrails. iCloud becomes the main consumer path; Git remotes
remain the power-user/backup path.

**Status:** implemented through Phase 3 (PR #501, which also carries PR #505's iOS Phase
1 leg); on-device verification is the release gate.

- **Phase 0:** exclusions, `.reflect/tmp/` staging, and placeholder handling landed.
  Spike 5 partially (the objc2 surface compiles for both targets; runtime proof needs a
  container). Spike 6 resolved: the engine is the vendored libgit2's buffer-level
  `git2::merge_file` (two quirks: it skips git2's lazy global init, and asserts on NULL
  input paths). **Spike 4 is the release blocker:** the macOS iCloud entitlements are
  restricted and need a Developer ID provisioning profile; they sit commented in
  `Entitlements.plist` with the enabling checklist. iOS signing rides
  `ios.project.yml`/`gen/apple` (PR #505).
- **Phase 1:** iOS container discovery, iCloud-first onboarding, unavailable-parking,
  resume nudge (PR #505). Desktop move-in (count+byte-verified copy; the original stays
  as the recovery copy) behind Settings → iCloud sync (macOS only), which disconnects a
  Git backup first (contract 5).
- **Phase 2:** `src-tauri/src/icloud/` (versions, conflict sweep, NSMetadataQuery watch);
  `icloud-controller.ts` mounts for `…/Mobile Documents/` roots.
- **Phase 3:** `src-tauri/src/conflict/` (the ladder + shadow store with the advance rule
  and a merge-pair loop breaker). Convergence covered by argument-order-independence tests.
- **Phase 4:** docs ([docs/icloud-sync.md](../icloud-sync.md)). Remaining: spike 4, the
  two-device manual matrix, and the deferred status-line upload/download mapping.

**Not in scope:** AI-assisted resolution (deferred; the ladder hands it a ready
`base/local/remote`), a rich diff viewer, Dropbox/Google Drive adapters,
Windows/Android, CloudKit record sync, shared graphs.

## Where we stand

**Reused unchanged:**

- **`.reflect/` was already local-only on macOS** (sync/backup exclusion keys +
  provider-ignore xattrs in bootstrap), so the SQLite-in-a-synced-folder hazard was solved
  there. It was a no-op on iOS.
- **Editor safety.** `note-session` parks external changes against a dirty buffer, pauses
  saves, and suppresses echoes. iCloud events enter through the same `externalChanged()`
  seam.
- **Change events.** Desktop has the `notify` watcher; **mobile has no watcher** (a stub).
  So on iOS the iCloud detection module *is* the external-change watcher.

**What iCloud actually does (this drives the design):**

- **Edit conflicts are not duplicate files.** iCloud picks a current version and stashes
  the losers as unresolved `NSFileVersion`s (with content, date, device name) for the app
  to resolve ([TN2336](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)).
  Unhandled, that is last-writer-wins with the loser hidden. We must not ship that.
- **Creation collisions do produce duplicates** (`2026-07-04 2.md`). Daily notes have
  deterministic names, so *two devices creating today's note offline is the most common
  conflict Reflect will see*. It needs a first-class rule.
- **Eviction produces placeholders.** Optimize Storage replaces `notes/foo.md` with a
  `.foo.md.icloud` stub, which the old watcher and scanner saw as deletion.
- Detection: `NSMetadataQuery`; versions: `NSFileVersion`; safe I/O: `NSFileCoordinator`.

## Design contracts

### 1. The graph lives in the ubiquity container

Both apps share `iCloud.<bundle-id>`; the root is `<container>/Documents/<graph-name>/`.
This is mandatory on iOS and the reliable `NSMetadataQuery` scope on macOS. A graph placed
manually under `com~apple~CloudDocs/` gets best-effort handling, but setup steers to the
container. Enabling iCloud is an explicit, reversible **move** (coordinated copy → verify
→ swap pointer → keep the original as a local backup until the user confirms).

### 2. One conflict representation: labeled markers, deterministic bytes

> **Current state:** the marker grammar below is historical. The ladder ends in a
> word-level merge that returns text. See [icloud-sync.md](../icloud-sync.md) and
> [git-backup-safety.md](../git-backup-safety.md) S9.

Unresolved conflicts were to become Plan 12 marker blocks, with two refinements:

- **Truthful labels** from `NSFileVersion.localizedNameOfSavingComputer` (fallback `this
  device` / `other device`).
- **Deterministic side order** by `(modificationDate, contentHash)`, not local/remote.
  Both devices may resolve the same conflict at once (each sees itself as current, a
  documented iCloud behavior), so both must produce byte-identical output to converge
  instead of ping-ponging.

### 3. The resolution ladder

In Rust, per conflicted note, first match wins, all silent:

1. **Identical / whitespace-only** → keep current.
2. **Three-way merge with the shadow base** (contract 4). Output must be byte-deterministic.
3. **Structural rules** where line merge is too blunt:
   - *Frontmatter:* key-wise; same key with different values falls through to step 5.
   - *Daily append-union:* when both versions share a prefix and differ only by appended
     blocks (the dominant case), keep the prefix plus both block sets, deduped by exact
     match, ordered by timestamp. Also the rule for **creation collisions**: merge
     `2026-07-04 2.md` into the canonical file (both seeded from the same template, so the
     prefix shape holds), then delete the duplicate.
4. **Binary assets** → keep both (`name (conflict <UTC time> <hash8>).ext`).
5. **Overlapping edits** → word-level merge that returns text. The floor: *never* silent
   last-writer-wins, *never* a leftover `note 2.md`.

Mark versions resolved and remove them only after the result is durably written.
Edit-vs-delete keeps the edit (Plan 12). A note with a dirty open session is skipped; the
session parks it and the ladder retries after flush.

### 4. The shadow base

Three-way merge needs an ancestor iCloud does not provide, so Reflect keeps
`.reflect/sync-base/<note-path>`, the note at its last known *synced* state. It advances
**only** when an external change is ingested cleanly, a resolution lands (both devices
converge on it), or a graph is adopted.

**Never on local saves:** advancing past content the other device has not seen would make
diff3 treat our additions as already merged and drop them. A stale base is safe (shared
early edits look identical to diff3). A *missing* base degrades to two-way, so losing
`.reflect/` costs merge quality, not data. Renames (Plan 17) move the base through the
same seam; a miss is again just a weaker merge.

### 5. Coexistence with Git sync, `.reflect/`, and eviction

- **`.git/` never syncs through iCloud.** Bootstrap excludes it like `.reflect/`. Merging
  two object stores file by file corrupts the repo; this also protects users who already
  put a Git graph in iCloud Drive. Consequence: Git history is per-device under iCloud.
- **Remote Git sync and iCloud sync are mutually exclusive per graph.** Two merge machines
  over the same files would fight, and per-device histories pushing one remote would
  non-FF forever. Enabling iCloud disconnects the remote (with a prompt); local checkpoint
  commits stay useful.

  A graph may still hold both, see [icloud-sync.md](../icloud-sync.md).
- **`.reflect/` exclusion goes cross-platform** (the resource key exists on iOS).
- **Eviction ≠ deletion.** Watcher and scan map `.name.ext.icloud` placeholders to an
  *upsert of a not-downloaded note*, never a remove. Opening or indexing a placeholder
  starts the download and shows a loading state. A mass-remove guard refuses a batch that
  would delete a large fraction of the graph without corroboration.
- **Temp files move out of synced dirs.** Temps next to the target strand `.tmpXXXXXX`
  litter that replicates to every device after a crash. They move to `.reflect/tmp/`
  (same volume, so rename stays atomic), and iCloud writes are coordinated.

### 6. Detection module (and the iOS watcher role)

A platform-gated `icloud/` objc2 module on a dedicated run-loop thread (like
`contacts.rs`/`calendar.rs`), never the main loop:

- **macOS:** `NSMetadataQuery` watches conflicts + upload/download state. Conflicts feed
  the ladder. The `notify` watcher still sees iCloud writes; content-hash gating makes
  double delivery idempotent.
- **iOS:** the query is the **sole external-change source**: it emits `index:changed` and
  feeds the ladder. Foreground-only, like the rest of mobile sync.
- **Status:** query state maps into the plain sync status (Synced / Syncing / Offline).

## Phases

**Phase 0 — Foundations & spikes** (each lands alone; several fix live hazards first):
`.reflect/` exclusion on iOS + `.git/` everywhere; temps → `.reflect/tmp/`; placeholder
handling + mass-remove guard (also helps Dropbox folders today); **spike 4, entitlements
& signing** for a Developer ID macOS app + iOS through the CI signing pipeline (the
release-blocking unknown; do it first); spike 5, the objc2 surface on both platforms;
spike 6, buffer-level three-way merge without a `Repository`, proven byte-deterministic.

**Phase 1 — Container & migration.** Off-main-thread container discovery; "Sync with
iCloud" in settings + onboarding; Git mutual-exclusion prompt; iOS migration from the
local Documents root; iCloud signed out → clear blocking state, never a silent empty graph.

**Phase 2 — Detection + the safe floor.** Ladder steps **1, 4, 5 only**, plus archive,
version cleanup, creation-collision detection, status, and a label-aware notice. *Ship
gate: a two-device edit conflict ends as one note; nothing is lost; a double-created
daily collapses to one file.*

**Phase 3 — The merge ladder.** Shadow base + rename integration, three-way as step 2,
structural rules as step 3, deterministic ordering, convergence property tests. *Ship
gate: append-only divergence, disjoint edits, and double-created dailies resolve with no
user interaction.*

**Phase 4 — Hardening & docs.** Two-device matrix (offline edits on both, double-create,
eviction under low storage, rename races, kill mid-save, signed-out iCloud), archive
pruning, docs.

## Failure cases

| Case | Behavior |
| --- | --- |
| Both devices resolve the same conflict at once | Deterministic ladder → identical bytes; iCloud sees agreement (or step 1). |
| Conflict arrives while the note is open + dirty | Session parks it; ladder retries after flush. |
| Simultaneous save, both online | Each sees the other as a conflict version; determinism converges them. |
| Ladder crashes mid-resolution | Versions stay unresolved; the next sweep retries. Nothing lost. |
| Evicted note opened / indexed | Download-on-demand + loading state; timeout → error, never a blank overwrite. |
| iCloud signed out / container missing | Blocking "iCloud unavailable" state with a local-copy escape hatch. |
| Shadow base missing/stale | Weaker merge, never data loss. |
| `private: true` note conflicts | Same handling; everything is local. The flag only gates the deferred AI step. |
| Placeholder mistaken for deletion | Cannot happen (mapping + guard); a true deletion still propagates (edits win). |

## Deferred

- **AI-assisted resolution** (the original step 6): when step 5 would fire and a BYOK
  provider is set, propose a merge from `base/local/remote` for review. The ladder already
  produces that triple. `private: true` hard-blocks it.
- Rich diff viewer.
- Dropbox/Drive adapters (duplicate detection + the same ladder).
- Background sync on iOS; Android/Windows.
