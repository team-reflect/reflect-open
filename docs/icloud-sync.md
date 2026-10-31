# iCloud Drive Sync

How Reflect syncs a graph through iCloud Drive ([Plan 21](plans/21-icloud-drive-sync.md)), and
what happens when two devices edit the same note while apart.

## The user contract

- **Where the graph lives.** In the app's iCloud Drive container, shown as **iCloud Drive →
  Reflect** in Files (iOS) and Finder (macOS). Notes stay plain markdown files.
- **Turning it on.** Onboarding on both platforms offers iCloud first and lists every graph in
  the container (it can hold several). An existing local graph moves later via Settings →
  **iCloud sync** → *Move graph to iCloud…*. That copies it into the container (verified file by
  file) and reopens it there. The original folder stays on disk as a recovery copy.
- **One sync method per graph (recommended).** Use iCloud Drive *or* a Git remote. Two sync
  engines on the same files fight, and a `.git` directory must never ride a file-sync provider
  (object-store corruption). Moving a graph to iCloud disconnects its GitHub backup first, and
  `.git`/`.reflect` are always marked local-only. A graph with both still works: Reflect commits
  locally as you type and pushes only after five quiet minutes with no pending iCloud downloads.

## What happens on a conflict

When both devices change the same note while apart, Reflect resolves it itself, in this order.
Resolution is deterministic: both devices produce identical bytes and converge.

1. **Same content** (or only whitespace differs): nothing to do.
2. **A merge keeps coming back**: the loop breaker keeps the newer side.
3. **Different parts of the note**: a three-way merge over the last synced state.
4. **Only metadata differs**: merged key by key.
5. **Both devices only appended**: both tails are kept, oldest first. This is the common
   daily-note case. Two devices creating the same day offline (iCloud leaves `2026-07-04 2.md`)
   fold back into one file the same way.
6. **Anything else**: a word-level merge keeps the words both sides added. Reflect never writes
   conflict markers.

The same ladder runs for a Git pull, the iCloud sweep, and an editor save that meets a newer file
on disk. Only `.md` files go through it.

Other files never merge as text on the iCloud path. The local file stays at its path, and each
other version lands beside it as `name (conflict <YYYY-MM-DD HH-MM-SS> <hash8>).ext` (UTC
modification time, first 8 hex digits of the content hash), so both devices write the same name.
The status hint lists every copy. Attachments are checked only on a full sweep (resume and
adoption), and only for whitelisted extensions. Other extensions get no copy, and their
conflict versions stay in iCloud.

## Building with iCloud

Dev builds report iCloud as unavailable unless the build is entitled and provisioned.

- **iOS**: Xcode automatic signing registers the container (`iCloud.app.reflect`) on the first
  entitled build.
- **macOS**: the committed Developer ID provisioning profiles (`Reflect.provisionprofile`,
  `Reflect-beta.provisionprofile`) grant the entitlements. They are bound to one Developer ID
  certificate: rotating it, or editing the App IDs' capabilities, means regenerating and
  re-committing both profiles. The dev flavor has no iCloud. Builds without Reflect's
  certificate report iCloud as unavailable.

The ladder, the merge-base store, and the conflict sweep are plain Rust with unit tests
(`cargo test -p reflect-open --lib -- conflict icloud`). Only the mobile `NSMetadataQuery`
watch, `NSFileVersion` conflict delivery, and download/eviction need a real container (and the
two-device manual matrix in the plan doc).

## Why the desktop app runs no metadata query

`.reflect/` and `.git/` are marked local-only (`mark_dir_local_only` in `fs/io.rs`), which keeps
the SQLite index and the backup repo off iCloud. But excluded directories carry no identity in
the provider database, and `NSMetadataQuery` trips over that. Measured on macOS 26.5 with an
entitled probe over the real container:

- The gatherer (`BRItemCollectionGatherer`) enumerates the **entire** container, one collection
  per directory, whatever the predicate or scope says. Every excluded directory, in any graph,
  fails the same way, and so does a `.nosync` directory.
- Each one fails with `NSFileProviderInternalErrorDomain 15 while gathering`, retries six
  rounds, then gives up (`Repeatedly can't watch item`). Each retry reloads the whole item tree
  through `fileproviderd`. Churn inside an excluded tree triggers it again.
- Once gathered, the query is silent at idle on macOS 26.

On macOS 15.6 the reload cycle never settled
([#1180](https://github.com/team-reflect/reflect-open/issues/1180)): `fileproviderd` sat near
200% CPU and Reflect near 40% until the app quit. No exclusion escapes the gather, so the
desktop app **does not run the metadata query**. The `notify` watcher already sees every iCloud
write there, arrival sweeps check the arrived notes, and the resume/focus sweep checks
everything. Mobile keeps the query: it is the only external-change source, and iOS has no file
watcher.

So on the Mac the app logs **no** `BRItemCollectionGatherer` errors. On iOS the burst appears at
each watch start and is benign. A real watcher failure is `iCloud metadata query failed to
start` (the `icloud:watch-failed` event) or update rounds stopping entirely.

## Deliberately not here (yet)

- **AI-assisted resolution**: the ladder already produces the base/local/remote triple a BYOK
  provider would use (see the plan's *Deferred* section). `private: true` notes will be blocked
  from it.
- Upload/download progress in the sync status line.
