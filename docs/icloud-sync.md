# iCloud Drive Sync

How Reflect syncs a graph through iCloud Drive (Plan 21 —
[design](plans/21-icloud-drive-sync.md)), and what happens when two devices
edit the same note while apart.

## The user contract

- **Where the graph lives.** In the app's iCloud Drive container — visible as
  **iCloud Drive → Reflect** in Files (iOS) and Finder (macOS). Notes stay
  plain markdown files; iCloud moves them between devices.
- **Turning it on.** Both platforms offer iCloud first during onboarding and
  list every graph already in the container (it can hold several): macOS's
  recommended card opens one or names-and-creates a new one, with a
  self-managed choose-your-own-folder alternative; iOS's first-run screen
  opens one (or stores fresh notes in iCloud), and its settings sheet
  switches between graphs later. An existing
  local graph moves later via Settings → **iCloud sync** → *Move graph to
  iCloud…*, which copies it into the container (verified file-by-file) and
  reopens it there; the original folder stays on disk, untouched, as a
  recovery copy.
- **One sync method per graph (recommended).** A graph syncs through iCloud
  Drive *or* a Git remote. Two sync engines merging the same files fight each
  other, and a `.git` directory must never ride a file-sync provider
  (object-store corruption). Moving a graph to iCloud disconnects its GitHub
  backup first, and `.git`/`.reflect` are always marked local-only as a
  belt-and-braces guard. A graph that has both still works: Reflect commits
  locally as you type, and pushes only after five quiet minutes with no
  pending iCloud downloads.

## What happens on a conflict

When both devices change the same note while apart, Reflect resolves it
itself where that is safe, in this order (deterministic — both devices
resolving the same conflict produce identical bytes and converge):

1. **Same content** (or only whitespace differs): nothing to do.
2. **A merge keeps coming back**: when the same two merge results collide
   again, the loop breaker keeps the newer side.
3. **Different parts of the note**: merged three-ways over the note's last
   synced state.
4. **Only metadata differs** (pinned on the Mac, marked private on the
   phone): merged key by key.
5. **Both devices only appended**: both tails are kept, oldest first. This
   applies to any note. It is the daily-note case, and the most common one.
   Two devices creating the same day's note offline (iCloud leaves a
   `2026-07-04 2.md` behind) fold back into one file the same way.
6. **Anything else**: a word-level merge keeps the words both sides added.
   Reflect never writes conflict markers.

The same ladder runs on every note path: a Git pull, the iCloud sweep, and an
editor save that meets a newer file on disk. Only notes (`.md` files) go
through the ladder.

Other files (JSON, text, PDF, audio, images, and so on) never merge as text on
the iCloud path. The file on the device stays at its path. Each other version
lands beside it as `name (conflict <YYYY-MM-DD HH-MM-SS> <hash8>).ext`. The
time is the UTC modification time of that version. `hash8` is the first 8 hex
digits of its content hash, so both devices write the same name. A version
equal to the current file writes no copy. The app lists every copy by its
graph path in the status hint.

The sweep checks attachments only on a full sweep (resume and adoption), and
only for extensions on the attachment whitelist. Files with other extensions
get no copy, and their conflict versions stay in iCloud.

## Building with iCloud

Dev builds report iCloud as unavailable unless the build is entitled and
provisioned:

- **iOS**: the entitlements + `NSUbiquitousContainers` declaration are in
  `ios.project.yml` / `gen/apple`; Xcode automatic signing registers the
  container (`iCloud.app.reflect`) on the first entitled build.
- **macOS**: the entitlements live in
  `apps/desktop/src-tauri/Entitlements.plist`, granted by the committed
  Developer ID provisioning profiles (`Reflect.provisionprofile` /
  `Reflect-beta.provisionprofile`, embedded pre-signing via
  `bundle.macOS.files`). They're bound to one specific Developer ID
  certificate — rotating it, or editing the App IDs' capabilities in the
  portal, means regenerating and re-committing both profiles. The dev flavor
  signs with `Entitlements.dev.plist` (no iCloud — its App ID has no
  profile), and plain contributor builds without Reflect's certificate
  simply report iCloud as unavailable.

Everything below the platform calls — the resolution ladder, the shadow
merge-base store, the conflict sweep — is plain Rust with unit tests
(`cargo test -p reflect-open --lib -- conflict icloud`) and runs identically
in CI. What *needs a real container* (and the two-device manual matrix in
the plan doc) is the mobile `NSMetadataQuery` watch, `NSFileVersion` conflict
delivery, and download/eviction behavior.

## Sync-excluded directories and the metadata query

`.reflect/` and `.git/` live inside the synced graph but are marked local-only
(`mark_dir_local_only` in `fs/io.rs`): the `com.apple.fileprovider.ignore#P`
xattr plus the `NSURLUbiquitousItemIsExcludedFromSyncKey` resource key (which
sets the same xattr). That keeps the live SQLite index and the backup repo
off iCloud, but it also means those directories carry no identity in the
provider database — and CloudDocs' `NSMetadataQuery` machinery trips over
exactly that.

Measured on macOS 26.5 with an entitled probe app over the real container
(the shape `icloud/watch.rs` builds — ubiquitous documents scope, path-prefix
predicate, serial delivery queue):

- The gatherer (`BRItemCollectionGatherer`) enumerates the app's **entire**
  container and builds one observed collection per directory, whatever the
  predicate says. Restricting the predicate (`NOT (path BEGINSWITH …/.reflect/)`),
  setting `searchItems`, or pointing the scope at note directories changed
  nothing (URL scopes route the query to Spotlight, which has no ubiquitous
  attributes at all). Every excluded directory in the container — in *any*
  graph it holds — fails identically, and so does a `.nosync` directory.
- Each excluded directory's collection fails with
  `NSFileProviderInternalErrorDomain 15 while gathering`, is retried with a
  10 → 50 ms linear backoff, and is given up on after six rounds
  (`[CRIT] UNREACHABLE: … BRItemCollectionGatherer - Repeatedly can't watch
  item`). Every retry reloads the whole item tree through `fileproviderd`: a
  three-graph container of ~13k items re-gathered six times in one start.
  Churn inside an excluded tree re-triggers the failure (a freshly created
  one produced 35 give-ups in a single run).
- Once gathered, the query is silent at idle on macOS 26.

On macOS 15.6 that reload cycle was observed never to settle
([#1180](https://github.com/team-reflect/reflect-open/issues/1180)): opening
an iCloud graph held `fileproviderd` around 200% CPU (`com.apple.fssync.fstree`
walks and xattr reads) and Reflect around 40% (File Provider XPC replies)
until the app quit. Since nothing scopes the gather below the container and
no exclusion mechanism escapes it, the desktop app **does not run the
metadata query at all**: the `notify` watcher already reports every iCloud
write there as a plain FS event, arrival-triggered conflict sweeps check the
arrived notes (`'ingested'` scope), and the resume/focus sweep checks
everything — the same backstop graphs kept outside the app's container always
relied on. Mobile keeps the query: it is the sole external-change source
there and iOS has no file watcher to fall back on.

So with a graph open on the Mac, the app's process logs **no**
`BRItemCollectionGatherer` errors. On iOS the burst still appears at each
watch start and is benign; a real watcher failure looks different —
`startQuery` returning false (logged as `iCloud metadata query failed to
start`, surfaced via the `icloud:watch-failed` event) or update rounds ceasing
entirely.

## Deliberately not here (yet)

- **AI-assisted resolution** — the ladder already produces the
  base/local/remote triple a BYOK provider would consume; see the plan's
  *Deferred* section. `private: true` notes will be hard-blocked from it.
- Upload/download progress in the sync status line.
