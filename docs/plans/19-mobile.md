# Plan 19 — Mobile companion (iOS first, Android next)

**Goal:** an iOS app, built from this repo as a new target of the existing
Tauri app: open to today's daily note, swipe through past/future days, **read
and edit notes in place**, quick-capture into today, create notes, lexical
search — over the same graph, kept in sync with desktop through the existing
GitHub backup/sync layer. Android follows on the same architecture shortly
after.

**Editing is a hard requirement.** A read-only browser is not a shippable v1;
the editor ladder in decision 7 always lands on an editing experience.

The shell decision (Tauri 2 mobile vs React Native/Expo/Capacitor/Ionic) is
recorded in [TDR 0003](../decisions/0003-mobile-shell.md). Summary: we keep the
Rust core (git2 sync, rusqlite/FTS5 index, keychain) and the React frontend by
building mobile as a target of the existing crate; Capacitor is the documented
fallback with explicit triggers.

> **Status (2026-06-14): In progress in source.** The app has the platform root gate
> (`src/platform-root.tsx`), mobile route shell (`src/mobile/`), fixed-root graph
> bootstrap/onboarding in `GraphProvider`, mobile-gated Rust commands and stand-ins
> (`mobile_graph_root`, `watcher_mobile.rs`, `embed_mobile.rs`), iOS identity/config, and
> the first-party `tauri-plugin-keyboard`. The Daily/All shell, editable note screen,
> note actions, share helper, and settings sheet exist. Still open: physical-device
> editing validation, full GitHub-connect restore polish on mobile, foreground-sync
> product hardening, TestFlight/App Store packaging, and Android follow-through.
>
> **Update (2026-07-05):** several scope lines below were superseded by later ships.
> [Plan 21](./21-icloud-drive-sync.md) made iCloud Drive the primary storage/sync
> path: onboarding is now iCloud-first (lists every container graph; keep-on-device
> and GitHub behind it), `mobile_storage` replaced `mobile_graph_root`, and the
> settings sheet grew a **Switch graph** section — so "one graph per device / no
> iCloud containers" no longer holds (one graph *open* at a time still does). The
> formatting toolbar shipped **webview-drawn** (decision 8), spike B passed with
> meowdown on device, mobile conflict resolution shipped (mine/theirs/both), and
> the TestFlight flow exists ([docs/ios-testflight.md](../ios-testflight.md)).

**Depends on:** Plans 02–05 (graph/storage, document model, index, **editor**),
06 (daily notes/route model), 07 (backlinks/autocomplete), 08 (lexical
search), 12 + 16 (GitHub sync over HTTPS + device flow), 17 (readable
filenames — the title-rename machinery rides along with editing).

**Unlocks:** Android (this plan, last step), share-sheet capture, mobile AI
(BYOK keys in the iOS keychain), widgets — all explicitly later waves.

## Scope

**In scope (v1):**

- The existing Tauri app building and running on iOS (`tauri ios dev/build`),
  with the crate's desktop-only capabilities target-gated.
- One graph per device, rooted in the app's sandboxed `Documents/` directory,
  visible in the iOS Files app (portability holds on mobile).
- Onboarding: **Start fresh** (create an empty graph) or **Connect GitHub**
  (device flow + clone), reusing `@reflect/core`'s sync/github module.
- Mobile UI surfaces, **per the 2026-06-12 product call: re-implement V1
  mobile's feature-set and design** (see the
  [V1 mobile overview](../reflect-v1-mobile-overview.md)): a **Daily / All**
  tab shell; the Daily tab as V1's signature surface (month header + week
  calendar strip + a touch-swipeable day carousel — Embla Carousel, recorded
  in [libraries](libraries.md)); editable note view; the All tab as a
  virtualized note list with embedded search and filter badges; a **new-note
  `+` button** (V1 parity — there is **no capture sheet**: the daily note
  itself is the capture surface, and `+` opens a fresh untitled note via the
  same seed/ghost-title flow as desktop's ⌘N); note actions (pin, share,
  trash); a settings sheet in V1's avatar spot (graph name, note count,
  GitHub connect/disconnect, sync status, version).
- **Editing**, reusing the desktop document stack wholesale (note sessions,
  document binding, open documents, title-rename, wiki-link autocomplete) —
  meowdown first, CodeMirror 6 live-preview as the editing fallback
  (decision 7).
- A small first-party Swift keyboard plugin (webview insets, keyboard-height
  events, caret visibility) — a prerequisite for editing, built early.
- Foreground sync: cycle on app resume, after edits (debounced), and on
  network regain; the in-process file-change channel replaces the watcher
  (decision 5); flush-on-background protects dirty buffers (decision 6).
- TestFlight distribution; App Store submission as the final step.

**Out of scope (explicitly):**

- AI: no copilot, no chat, no BYOK keys on mobile v1. (The architecture holds —
  keys would live in the iOS keychain via the same secrets module — but the
  surface is a later wave.)
- Semantic search/embeddings: `fastembed`/ORT is desktop-only; mobile search is
  lexical (FTS5), per the product vision.
- Audio memos, link capture, share-sheet capture (share *target* needs its own
  native plugin — later).
- Multiple graphs, graph chooser, folder pickers, iCloud Drive containers.
- Background sync (BGTaskScheduler), push notifications, widgets, auto-update
  (app stores own updates; the updater plugin is already desktop-gated).
- Full keyboard-shortcut surfaces (⌘K palette), a native formatting accessory
  bar (a webview-drawn toolbar may come later, positioned via the keyboard
  plugin's height events), the CLI sidecar (already excluded from mobile
  bundles by the platform-overlay configs).

## Key decisions / contracts

### 1. One app, three platforms — no `apps/mobile`

Mobile is a build target of `apps/desktop` (the crate is already mobile-aware:
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`, desktop-gated updater,
`gen/apple/` + `ios.project.yml` from a prior `tauri ios init`). A separate app
would duplicate the Rust shell, the IPC wiring, and the Tauri config for no
isolation benefit. (A later cosmetic rename of `apps/desktop` → `apps/app` is
allowed but not required by this plan.)

Conditional surface, by layer:

| Layer | Mechanism |
|---|---|
| Rust deps | `[target.'cfg(not(any(target_os = "ios", target_os = "android")))'.dependencies]` for desktop-only crates |
| Rust code | `cfg(desktop)` / `cfg(mobile)` (already in use) |
| Permissions | `capabilities/` split: shared `default.json`, existing `desktop.json`, new `mobile.json` with `"platforms": ["iOS", "android"]` (must carry the GitHub/device-flow http grants) |
| Bundling | existing `tauri.<platform>.conf.json` overlays (sidecar stays desktop-only); add `tauri.ios.conf.json` only if iOS needs overrides |
| Frontend | runtime platform gate at the root, lazy-loaded chunks (below) |

### 2. Rust crate: what gates off on mobile

| Capability | Desktop | Mobile v1 |
|---|---|---|
| `watcher` (notify) | watches external edits | **off** — nothing else writes the sandbox; local writes notify in-process (decision 5) |
| `embed` (fastembed/ORT, hf-hub) | semantic search | **off** — target-gated out; lexical only |
| `trash` crate (note delete) | OS trash | move to graph-local `.reflect/trash/` (recoverable, sync-ignored) |
| `tauri-plugin-window-state` | window restore | off (not mobile-supported) |
| updater + process plugins | auto-update | already gated; app stores update |
| CLI sidecar | bundled via overlays | already excluded |
| `git2` (vendored libgit2 + OpenSSL) | SSH + HTTPS | **HTTPS/token path only** — exactly what managed GitHub sync uses; SSH-agent flows are desktop-only |
| `keyring` | macOS keychain | iOS keychain (`apple-native` covers both — verify in the gate spike) |
| rusqlite + FTS5, fs primitives, settings | as-is | as-is |

The index, document model, and fs modules need no mobile fork: same SQLite
file under `<graph>/.reflect/`, same markdown contract.

### 3. Graph bootstrap: fixed root, no chooser, no persisted paths

Mobile has no folder picking. The graph root is a fixed, Rust-provided path —
the app's `Documents/` directory (sketch: a `mobile_graph_root()` command;
`graph_create`/`graph_open`/`gitClone` take it from there). **Derive the root
at every launch and never persist absolute paths**: iOS app-container paths
embed a UUID that changes across restore/update, so the desktop recents-store
pattern (absolute paths on disk) must not be ported. `Documents/` is exposed
in the Files app via `UIFileSharingEnabled` +
`LSSupportsOpeningDocumentsInPlace` in the `ios.project.yml` Info.plist
properties — the user can see, copy, and back up their markdown on device.
`.reflect/` stays a dot-directory (hidden by Files by default).

Onboarding routes through two paths and lands on Today:

- **Start fresh** → `graph_create(root)`.
- **Connect GitHub** → existing device flow (`runDeviceFlow` opens
  github.com/login/device via the opener plugin; user enters the code in
  Safari; poll completes), token → keychain, then `gitClone` into the root,
  then the initial index build with progress UI.

### 4. Frontend: one bundle, runtime platform gate, mobile surface tree

```tsx
// main.tsx — platform gate; each side stays a lazy chunk
const MobileApp = lazy(() => import('@/mobile/mobile-app'))
const DesktopApp = lazy(() => import('@/app'))
root.render(platform() === 'ios' || platform() === 'android' ? <MobileApp /> : <DesktopApp />)
```

- New subtree `apps/desktop/src/mobile/` (kebab-case, one component per file):
  `mobile-app.tsx`, `screens/` (onboarding, today, note, notes-list, search,
  capture, settings), `components/` (tab bar, sync status pill, day pager).
- **Reuses:** providers (graph, theme, query client), `@reflect/core` getters/
  setters, the design system tokens, the typed `Route` union (subset: `today`,
  `daily`, `note`, `search`) over a mobile stack/tab navigation — no URL
  router dependency, same as desktop — **and the entire editor/document stack**
  (decision 7).
- **Does not reuse:** desktop chrome (sidebars, titlebar overlay, ⌘K palette,
  window-state). Those stay desktop-only chunks; the lazy gate keeps them out
  of the mobile critical path.
- Viewport/safe areas: `viewport-fit=cover`, design-system tokens for
  `env(safe-area-inset-*)`, minimum 16px input font (blocks iOS auto-zoom).

### 5. No watcher: local writes notify in-process

On desktop, the watcher is the sole incremental-reindex path — editor saves
flow file → watcher → index, and the backup controller marks the sync engine
dirty from the same events. Mobile has no watcher, and the replacement seam
**already exists**: `emitFileChanges` in `packages/core/src/indexing/
file-changes.ts`, the in-process channel the backup controller already uses
for pull-applied writes ("must not depend on the file watcher being up").
Every consumer — incremental reindex (`subscribeIndexChanges`), TanStack Query
invalidation, the engine's `noteChanged`, and open-editor reconciliation
(which recognizes its own save as an echo by content match) — hangs off that
one channel and behaves identically either way.

**Contract:** on mobile, every local write seam emits its change batch after
the write lands — the note-session save pipeline, `create-note`, capture
appends, asset writes, deletes. One mechanism, no mobile-only index or sync
logic. Pull-applied changes keep flowing through the existing
`onRemoteChanges` → `emitFileChanges` path unchanged. (The engine's
documented no-loop invariant holds: a notification with nothing new to commit
ends without touching the network.)

### 6. Lifecycle: flush on background, survive webview death

Editing makes suspension a data-loss class: saves debounce (800ms default) and
iOS both suspends the process soon after backgrounding and may kill the
WebContent process outright. Contract, extending the quit-flush trio
(`lib/quit-flush.ts`) with a mobile leg:

- **On background** (visibility/pause): flush open documents + settings, then
  a local commit (never a push — same as desktop quit; the next resume cycle
  pushes).
- **On resume:** run a sync cycle; verify the webview survived (the
  resume-with-dead-webview class — [tauri#14371](https://github.com/tauri-apps/tauri/issues/14371);
  verify our pinned Tauri includes the fix). A relaunch after process death
  must reopen the graph and land back on the last route with no buffer loss —
  which the background flush guarantees.

### 7. The editor: meowdown first, CodeMirror 6 fallback — editing either way

Editing markdown in WKWebView was the defunct V1 mobile app's deepest pain
(ProseMirror focus/selection/keyboard timing). That makes it the plan's
highest risk — so it is **front-loaded as a gate spike (step 2)**, not
deferred. The ladder:

- **Primary: meowdown** — the same editor stack as desktop, mounted by the
  mobile note screen. Evaluate on a real device, with the keyboard plugin
  active: focus acquisition, IME/autocorrect, selection/caret behavior,
  scroll-caret-into-view above the keyboard, `[[` autocomplete (touch
  selection, popover positioned within the visual viewport).
- **Fallback: CodeMirror 6 in markdown live-preview mode** — already this
  project's documented fallback for meowdown on desktop (00-overview, risk 1),
  and proven on iOS at scale: it is what Obsidian mobile ships. CM6 edits the
  raw markdown, so round-trip fidelity is structurally safe; we lose WYSIWYG
  polish, not editing. Wiki-autocomplete would need a CM6 port of the entry
  source (the entries layer in `wiki-autocomplete-entries.ts` is
  editor-agnostic).
- **Not on the ladder:** read-only browsing. If both rungs fail on quality,
  that is a product-level escalation (see Risks), not a silent downgrade.

Whichever rung ships, mobile reuses the desktop document machinery wholesale —
`note-session` (debounced atomic saves, frontmatter held out of the editor,
round-trip-fidelity protection, conflict park), `document-binding`,
`open-documents`, the title-rename/`rename-coordinator` path (settled-title
file moves work identically; they're platform-neutral TS). **No second write
path.** Protected notes (lossy round-trip, conflicts) open read-only on mobile
exactly as on desktop.

iOS text-input hygiene is part of the gate: set `autocapitalize`/
`autocorrect`/`spellcheck` deliberately on the editing surface, and verify
iOS smart punctuation does not corrupt syntax (`[[`, code spans, fences) —
disable smart quotes for the editing surface if it does.

### 8. Keyboard plugin (first-party Swift) — an editing prerequisite

Tauri iOS has no keyboard handling ([tauri#9907](https://github.com/tauri-apps/tauri/issues/9907)):
the keyboard occludes the webview rather than resizing it. Ship a minimal
first-party mobile plugin (Tauri mobile-plugin layout, Swift now, Kotlin
later): observe `keyboardWillShow/Hide/changeFrame`, adjust the webview's
bottom inset, and emit keyboard-height events to JS (exposed as a CSS
variable for sticky UI and autocomplete positioning). Caret visibility
(scroll-into-view above the keyboard) is part of this plugin's acceptance,
tested with the editor spike. No accessory-bar class-swizzling (a V1-mobile
lesson — that path was brittle); a webview-drawn formatting bar can come
later on the height events.

> **Refined 2026-07-02 (PR #477): the shell yields by height, not padding.**
> Per-container `max(safe-area, keyboard)` padding fixed scroll reach but
> left the *layout* (and floating-ui's positioning boundary) extending under
> the keyboard, so every floating surface — the `[[` autocomplete first —
> needed its own fitting workaround. Instead, the mobile shell root is
> `calc(100dvh - var(--keyboard-height))`: one yield point, correct popup
> positioning for free, containers keep plain safe-area padding, and only
> `position: fixed` elements (viewport-anchored) read the variable directly.
> The tab bar hides while the keyboard is up — V1 let the keyboard cover it,
> and above the keyboard it would just eat typing space.

### 9. App identity & store

The iOS template now carries the product identity (`app.reflect.ios`, product
name "Reflect", team `789ULN5MZB`) and `tauri.ios.conf.json` keeps the mobile
bundle identifier separate from the desktop app. Versioning tracks the desktop
`version` in `tauri.conf.json`; TestFlight builds use `pnpm release:ios` to add
the per-upload build number and pass App Store Connect API key authentication
through to xcodebuild/altool. Store metadata, privacy nutrition labels
(`PrivacyInfo.xcprivacy` is required for fs access), and a review-account
story (a demo graph — the app is fully usable with no account; reviewers must
see that) land with the submission step.

## Steps

Steps 1 and 2 are the existential gates; nothing else starts until both pass.

1. **Gate spike A — the crate on iOS (timeboxed).** Target-gate
   `fastembed`/`hf-hub`, `notify`, `trash`, `window-state`; build for
   `aarch64-apple-ios`; boot the webview via `tauri ios dev` (device dev loop
   needs `TAURI_DEV_HOST` for the Vite server). Verify on simulator + one
   device: git2 vendored OpenSSL cross-compile, keyring round-trip to the iOS
   keychain, rusqlite FTS5 query, fs read/write under `Documents/`. *Failures
   here trip TDR 0003's fallback triggers.*

   > **Status (2026-06-12): simulator half passed.** The crate cross-compiles
   > clean for `aarch64-apple-ios`, and the app boots on the iPhone 17 Pro
   > simulator with the frontend rendering and all four runtime probes green
   > (keychain round-trip, FTS5 query, `Documents/` file IO, libgit2
   > init+commit — the temporary `spike_mobile.rs` instrumentation).
   > One real finding: cargo's `rustc-link-lib` directives don't reach the
   > final Xcode link, so libgit2's zlib/iconv must be declared in
   > `ios.project.yml` (`libz.tbd`, `libiconv.tbd`); after editing the
   > template, re-run `tauri ios init` to regenerate `gen/apple/`.
   > Remaining: the same probes on a physical iPhone.

2. **Gate spike B — editing on a real iPhone (timeboxed).** Prototype the
   Swift keyboard plugin (decision 8) far enough to evaluate honestly, then
   run the meowdown checklist from decision 7 on-device. Outcome is a
   decision: meowdown passes → proceed; meowdown fails on quality → commit to
   the CM6 rung and size the port; both fail → escalate per Risks. *The
   editor choice is locked here, before any screen is built.*
3. **Land the mobile crate surface.** The cfg-gating from spike A done
   properly: mobile delete-to-`.reflect/trash/`, `mobile_graph_root()`,
   `capabilities/mobile.json`, Info.plist file-sharing keys, identity cleanup
   (decision 9). Desktop builds and tests stay green throughout.
4. **Frontend platform gate + mobile shell skeleton.** The lazy root gate,
   `src/mobile/` tree, tab/stack navigation over the `Route` subset, theme +
   safe-area tokens, sync-status pill stub. Desktop bundle unaffected
   (verify chunk split).

   > **Status (2026-06-14): steps 3–4 have moved past skeleton.** Done:
   > `mobile_graph_root` + `app_platform` commands with core wrappers,
   > Files-app exposure (`UIFileSharingEnabled` +
   > `LSSupportsOpeningDocumentsInPlace`), identity normalized to
   > `app.reflect.ios` / product name Reflect, the lazy `PlatformRoot` gate
   > (desktop chrome split into `desktop-root.tsx`), the fixed-root mobile
   > bootstrap in `GraphProvider`, and the `MobileShell` route tree. The mobile
   > surfaces now include Daily, All/search, editable note pages, note actions,
   > share helper, onboarding, and settings sheet. **Verified earlier on the
   > simulator end-to-end:** boot → auto-bootstrap in `Documents/` → type into
   > meowdown → the daily note lands on disk through the shared save pipeline.
   > Remaining from the gate: physical-device editing validation and final
   > product hardening.
   >
   > **Also landed 2026-06-12: step 5 and the decision-8 keyboard plugin.**
   > The write-event seam ships as `setLocalWriteEcho`/`echoLocalWrite` in
   > core — `writeNote`/`writeAsset`/`deleteNote` emit their change batch
   > in-process after the write lands, enabled by the mobile root chunk at
   > load, unit-tested (including no-emit-on-failed-write).
   > `plugins/tauri-plugin-keyboard` (workspace member, mobile-only dep)
   > implements decision 8: Swift disables the system scroll nudge and
   > streams keyboard overlap as `keyboardChange` events; the frontend
   > mirrors it into `--keyboard-height` and Today's scroll container yields
   > via `max(safe-area, keyboard)`. **Simulator-verified with the software
   > keyboard: the caret line stays visible above the keyboard while
   > editing.** Gotcha worth keeping: `registerListener`/`remove_listener`
   > (those exact spellings) must be in a plugin's `COMMANDS` for
   > `addPluginListener` to pass the ACL. `capabilities/mobile.json` now
   > exists (keyboard:default). Spike B's remaining on-device checklist
   > (IME, autocorrect, selection, real-device feel) still gates the editor
   > decision.
5. **The in-process write-notification seam (decision 5).** Local write paths
   emit file-change batches on mobile; prove with a unit-level test that a
   session save reaches the index and the engine's dirty mark without a
   watcher. This is small and unblocks editing + search + sync alike.
6. **Onboarding + graph bootstrap.** Start-fresh and Connect-GitHub flows;
   device flow + clone into the fixed root; keychain-stored token; initial
   index build with progress.
7. **Today + note editing.** Today screen with day pager (prev/today/next);
   the note screen mounting the chosen editor over the desktop document stack
   (sessions, binding, open-documents, title-rename); wiki-link autocomplete
   under touch; flush-on-background (decision 6); images render via the asset
   protocol.
8. **Tab shell + All tab.** The Daily / All tab bar; the All tab as a
   virtualized note list with an embedded search bar and filter badges over
   the existing FTS getters (V1's All Notes shape), result → note.
9. **Daily V1 parity + new note.** Month header + week calendar strip + the
   Embla day carousel replacing the chevron pager; the `+` button opens a
   fresh untitled note (desktop's ⌘N seed/ghost-title flow — V1 had no
   capture sheet, and the 2026-06-12 product call removed the V2 one). Then
   the settings sheet (V1's avatar spot) and note actions (pin, share via the
   webview's Web Share API — `navigator.share`, verified working in the Tauri
   iOS WKWebView, so no native plugin — and trash).
10. **Sync wiring.** Resume/edit/online triggers, background-flush + local
    commit on pause, `onRemoteChanges` reindex (unchanged), conflicted notes
    protected with raw-marker resolution actions, status pill live.
11. **Harden + ship.** Memory pass on a large graph (webview process limits;
    editing a very large note), resume-after-process-death recovery check,
    a11y labels, TestFlight build (`pnpm release:ios testflight`; see
    `docs/ios-testflight.md`), then App Store submission with the review story.
12. **Android (fast follow, same shape).** `tauri android init`, Kotlin half
    of the keyboard plugin, keystore signing, the same frontend gate already
    matching `'android'`, Play submission. No new product surface.

## Acceptance criteria

- `pnpm tauri ios dev` runs the mobile app in the simulator from a clean
  checkout (see [the simulator runbook](../contributing/mobile-simulator.md));
  `pnpm tauri dev` (desktop) is unaffected; `cargo test -p reflect-open` and
  the TS suites stay green.
- Fresh install → Start fresh → today's note exists on disk under
  `Documents/`, visible in the Files app; capture appends markdown that
  desktop later pulls intact.
- Fresh install → Connect GitHub → device flow completes, the desktop graph
  clones, Today shows today's (or an empty) daily note; an edit on mobile
  appears on desktop after its next pull, and vice versa.
- **Editing:** open an existing note on device, edit it (including a
  `[[wiki link]]` inserted via autocomplete), and the save round-trips with
  no markdown corruption (smart punctuation, autocorrect artifacts included);
  a mobile edit shows up in search results and backlinks **without an app
  restart** (proves the decision-5 seam end-to-end).
- **No buffer loss:** background the app mid-edit (within the save debounce),
  kill it from the app switcher, relaunch — the edit is on disk and visible.
- The keyboard never permanently occludes the editor or capture input, and
  the caret stays visible above the keyboard while typing (notched device,
  portrait + landscape).
- A conflicted note opens protected with its "Needs review" state, offers
  mine/theirs/both resolution actions, and never blocks sync of other notes; a
  lossy-round-trip note opens protected, same as desktop.
- No `private: true` content leaves the device: mobile v1 makes **no** AI or
  transcription calls at all; network egress is GitHub (sync) only.
- A TestFlight build installs and survives backgrounding/resume without a
  blank webview; the App Store build passes review (or its rejection is
  triaged against TDR 0003's fallback triggers).

## Risks

1. **Editing in WKWebView (the V1-mobile scar) — now the headline risk, by
   construction.** Mitigations: gate spike B happens before any UI is built;
   the keyboard plugin is built to prerequisite level first; the CM6 rung is
   an editing fallback with independent large-scale proof (Obsidian mobile).
   If **both** rungs fail on-device quality, that is a product-level
   escalation — the honest options at that point are native-editor territory
   (e.g. an RN/native input layer), which no webview shell fixes — and the
   whole mobile approach gets re-decided with that data. The plan's bet is
   that Obsidian's existence makes this outcome unlikely.
2. **Tauri mobile early-adopter risk (the TDR's core bet).** Keyboard
   (#9907) and lifecycle (#14371) are known and mitigated (first-party
   plugin; resume-recovery check); unknown unknowns remain. Mitigation:
   spike A is a hard gate; fallback documented with triggers in TDR 0003.
3. **Editor divergence if the CM6 rung ships.** Two editors (desktop
   meowdown, mobile CM6) mean divergent behavior and a second integration to
   maintain — accepted consciously at the step-2 decision point, recorded in
   a TDR addendum if taken; the document stack underneath (sessions, saves,
   renames) stays shared either way.
4. **Cross-compiling the vendored stack** (OpenSSL/libssh2/libgit2 for iOS,
   later Android NDK). Known-workable but fiddly; isolated in spike A.
5. **Store review.** 4.2 minimal-functionality risk is low (offline-capable,
   local data, editing, Files integration) but real for webview shells; the
   reviewer-facing demo-graph story is part of step 11, and the repo being
   public by then removes the private-updater-endpoint class of surprises.
6. **Clone size on mobile networks.** Large graphs (assets) make first clone
   slow; v1 accepts it (progress UI), with shallow/partial clone noted as a
   follow-up — it must not fork the desktop sync contract casually.
7. **Webview memory on huge graphs / large notes.** Lists are virtualized
   already; editing very large notes is the new pressure point — the memory
   pass in step 11 is the checkpoint, with pagination and note-size guardrails
   as the noted levers.
