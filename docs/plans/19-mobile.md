# Plan 19 — Mobile companion (iOS first, Android next)

**Goal:** an iOS app built as a new target of the existing Tauri app: open to today,
swipe through days, **read and edit notes in place**, capture into today, create notes,
lexical search, over the same graph, synced with desktop through GitHub backup/sync.
Android follows on the same architecture.

**Editing is a hard requirement.** A read-only browser is not a shippable v1; the
decision 7 ladder always lands on editing.

The shell decision is [TDR 0003](../decisions/0003-mobile-shell.md): keep the Rust core
(git2, rusqlite/FTS5, keychain) and the React frontend by building mobile as a target of
the existing crate; Capacitor is the fallback with explicit triggers.

> **Status (2026-06-14): in progress in source.** Platform root gate, mobile route shell,
> fixed-root bootstrap/onboarding, mobile-gated Rust commands and stand-ins, iOS identity,
> and the first-party `tauri-plugin-keyboard` exist, as do the Daily/All shell, editable
> note screen, note actions, share helper, and settings sheet. Open: physical-device
> editing validation, GitHub-connect restore polish, foreground-sync hardening,
> TestFlight/App Store packaging, Android.
>
> **Update (2026-07-05):** [Plan 21](./21-icloud-drive-sync.md) made iCloud Drive the
> primary storage/sync path: onboarding is iCloud-first (lists every container graph;
> keep-on-device and GitHub behind it), `mobile_storage` replaced `mobile_graph_root`,
> and settings has **Switch graph**. So "one graph per device / no iCloud containers" no
> longer holds (one graph *open* at a time still does). The formatting toolbar shipped
> **webview-drawn**, spike B passed with meowdown on device, and the TestFlight flow
> exists ([docs/distribution.md](../distribution.md)).

**Depends on:** Plans 02–08, 12 + 16 (GitHub sync over HTTPS + device flow), 17
(title-rename rides along with editing).
**Unlocks:** Android, share-sheet capture, mobile AI, widgets (all later waves).

## Scope

**In scope (v1):**

- The Tauri app on iOS, with desktop-only capabilities target-gated.
- One graph per device in the sandboxed `Documents/`, visible in the Files app
  (portability holds on mobile).
- Onboarding: **Start fresh** or **Connect GitHub** (device flow + clone).
- **Per the 2026-06-12 product call, re-implement V1 mobile's feature set and design**
  ([V1 mobile overview](../reflect-v1-mobile-overview.md)): **Daily / All** tabs; Daily
  as V1's signature surface (month header + week strip + Embla day carousel); editable
  note view; All as a virtualized list with search and filter badges; a **`+` new-note
  button** (V1 parity: **no capture sheet**; the daily note is the capture surface, and
  `+` uses desktop's ⌘N seed/ghost-title flow); note actions (pin, share, trash); a
  settings sheet in V1's avatar spot.
- **Editing** reusing the desktop document stack wholesale; meowdown first, CodeMirror 6
  as the fallback (decision 7).
- A small first-party Swift keyboard plugin, built early (an editing prerequisite).
- Foreground sync (resume, debounced edits, network regain); in-process change channel
  instead of a watcher; flush-on-background.
- TestFlight, then App Store.

**Out of scope:**

- AI on mobile v1 (keys would live in the iOS keychain via the same secrets module; the
  surface is a later wave).
- Semantic search (`fastembed`/ORT is desktop-only); mobile search is lexical.
- Audio memos, link capture, share-sheet capture (the share *target* needs a native plugin).
- Multiple graphs, chooser, folder pickers, iCloud containers.
- Background sync, push, widgets, auto-update (app stores own updates).
- ⌘K palette, a native formatting accessory bar (a webview-drawn bar may come later), the
  CLI sidecar.

## Key decisions / contracts

### 1. One app, three platforms — no `apps/mobile`

Mobile is a build target of `apps/desktop` (the crate was already mobile-aware). A
separate app would duplicate the Rust shell, IPC wiring, and Tauri config for no isolation
benefit. Conditional surface: target-gated Rust deps, `cfg(desktop)`/`cfg(mobile)` code,
a `capabilities/` split with a mobile file (it must carry the GitHub http grants),
platform config overlays (sidecar stays desktop-only), and a frontend root gate.

### 2. Rust crate: what gates off on mobile

| Capability | Mobile v1 |
|---|---|
| `watcher` (notify) | **off**: nothing else writes the sandbox; local writes notify in-process |
| `embed` (fastembed/ORT) | **off**: lexical only |
| `trash` crate | graph-local `.reflect/trash/` (recoverable, sync-ignored) |
| window-state, updater, CLI sidecar | off / already gated |
| `git2` | **HTTPS/token only** (what managed GitHub sync uses); SSH agent is desktop-only |
| `keyring` | iOS keychain via `apple-native` |
| rusqlite + FTS5, fs, settings | as-is |

The index, document model, and fs modules need no mobile fork.

### 3. Graph bootstrap: fixed root, no chooser, no persisted paths

The root is a fixed, Rust-provided path (the app's `Documents/`). **Derive it at every
launch and never persist absolute paths**: iOS container paths embed a UUID that changes
across restore/update, so the desktop recents pattern must not be ported. `Documents/` is
exposed in Files via Info.plist keys; `.reflect/` stays hidden. Onboarding: Start fresh →
`graph_create`; Connect GitHub → device flow in Safari, token → keychain, clone, initial
index build with progress.

### 4. Frontend: one bundle, platform gate, mobile surface tree

> **Update:** shell builds no longer decide at run time. `vite.config.ts` aliases
> `@platform-root` from `TAURI_ENV_PLATFORM`, so each build imports only its own tree.
> Plain `vite` (browser dev) gets `platform-root.unknown.tsx`, which installs the dev
> bridge and honors `?platform=`.

- `apps/desktop/src/mobile/` holds screens and components.
- **Reuses:** providers, core getters/setters, design tokens, the `Route` subset over
  mobile stack/tab navigation (no URL router dependency), **and the whole editor/document
  stack**.
- **Does not reuse:** desktop chrome (sidebars, titlebar, palette, window state).
- Safe areas via `viewport-fit=cover` + tokens; minimum 16px input font (blocks iOS
  auto-zoom).

### 5. No watcher: local writes notify in-process

On desktop the watcher is the sole incremental-reindex path. The mobile replacement seam
**already existed**: the in-process file-change channel the backup controller uses for
pull-applied writes. Reindex, query invalidation, the engine's dirty mark, and editor
reconciliation (which spots its own save as an echo by content) all hang off it.

**Contract:** on mobile, every local write seam emits its change batch after the write
lands. One mechanism, no mobile-only index or sync logic. The engine's no-loop invariant
holds (nothing new to commit → no network).

### 6. Lifecycle: flush on background, survive webview death

Saves debounce (800 ms), and iOS suspends the process soon after backgrounding and may
kill WebContent outright, so editing makes suspension a data-loss class.

- **On background:** flush open documents + settings, then a local commit (never a push,
  same as desktop quit).
- **On resume:** sync cycle; verify the webview survived
  ([tauri#14371](https://github.com/tauri-apps/tauri/issues/14371)). A relaunch after
  process death must reopen the graph on the last route with no buffer loss.

### 7. The editor: meowdown first, CodeMirror 6 fallback — editing either way

Editing markdown in WKWebView was the defunct V1 mobile app's deepest pain (ProseMirror
focus/selection/keyboard timing), so it is **front-loaded as gate spike B**:

- **Primary: meowdown**, evaluated on a real device with the keyboard plugin: focus,
  IME/autocorrect, selection, caret above the keyboard, `[[` autocomplete under touch.
- **Fallback: CodeMirror 6 live preview**, already the desktop fallback and proven on iOS
  at scale (Obsidian mobile). It edits raw markdown, so round-trip fidelity is
  structurally safe; we lose WYSIWYG polish, not editing. Autocomplete would need a CM6
  port of the editor-agnostic entries layer.
- **Not on the ladder:** read-only browsing. Both rungs failing is a product escalation.

Either way, mobile reuses `note-session`, `document-binding`, `open-documents`, and the
rename path. **No second write path.** Protected notes open read-only as on desktop.

iOS text-input hygiene is part of the gate: set `autocapitalize`/`autocorrect`/
`spellcheck` deliberately, and disable smart quotes if they corrupt `[[`, code spans, or
fences.

### 8. Keyboard plugin (first-party Swift) — an editing prerequisite

Tauri iOS has no keyboard handling ([tauri#9907](https://github.com/tauri-apps/tauri/issues/9907)):
the keyboard occludes the webview. A minimal first-party plugin adjusts the webview and
exposes keyboard height to CSS. Caret visibility is part of its acceptance. No
accessory-bar class-swizzling (brittle in V1 mobile).

> **Refined 2026-07-02 (PR #477): the shell yields by height, not padding.**
> Per-container `max(safe-area, keyboard)` padding fixed scroll reach but left the layout
> (and floating-ui's boundary) under the keyboard, so every floating surface needed a
> workaround. Instead the mobile shell root is `calc(100dvh - var(--keyboard-height))`:
> one yield point, correct popup positioning, and only `position: fixed` elements read
> the variable. The tab bar hides while the keyboard is up (above it, it would eat typing
> space).

### 9. App identity & store

Identity `app.reflect.ios`, product name "Reflect", team `789ULN5MZB`; the iOS config
keeps the mobile bundle identifier separate from desktop. Versioning tracks the desktop
`version`; TestFlight builds add a per-upload build number and use App Store Connect API
key auth (`pnpm build:ios` + `pnpm upload:testflight`, run by
`.github/workflows/publish-testflight.yml`). Store metadata, privacy labels
(`PrivacyInfo.xcprivacy` is required for fs access), and a review story (a demo graph;
the app needs no account) land with submission.

## Steps

Steps 1 and 2 are the existential gates; nothing else starts until both pass.

1. **Gate spike A — the crate on iOS.** Target-gate desktop crates; build for
   `aarch64-apple-ios`; verify git2 vendored OpenSSL, keychain, FTS5, and `Documents/`
   IO on simulator + device. *Failures trip TDR 0003's fallback triggers.*

   > **Status (2026-06-12): simulator half passed.** All four probes green. Finding:
   > cargo's `rustc-link-lib` directives do not reach the final Xcode link, so libgit2's
   > zlib/iconv must be declared in `ios.project.yml` (`libz.tbd`, `libiconv.tbd`); after
   > editing the template, re-run `tauri ios init`.
   >
   > **Status (2026-07-31): `spike_mobile.rs` removed.** The formal device run never
   > happened, but every probed capability has shipped in production iOS features, which
   > settles the gate. The probe ran on every launch on the main thread after the window
   > showed, so it had become a startup cost.

2. **Gate spike B — editing on a real iPhone.** Prototype the keyboard plugin, run the
   meowdown checklist on device, and lock the editor choice before any screen is built.
3. **Mobile crate surface** (gating, `.reflect/trash/`, fixed root, mobile capabilities,
   Files keys, identity). Desktop stays green.
4. **Frontend platform gate + shell skeleton.** Verify the desktop chunk split.

   > **Status (2026-06-14): steps 3–4 are past skeleton.** **Verified on the simulator
   > end-to-end:** boot → auto-bootstrap in `Documents/` → type into meowdown → the daily
   > lands on disk through the shared save pipeline. Remaining: device validation and
   > product hardening.
   >
   > **Also landed 2026-06-12: step 5 and the keyboard plugin.** The write-event seam
   > (now `FileChangeService.reportOwnWrite`) emits after each write, with a test for
   > no-emit-on-failed-write. **Simulator-verified: the caret stays above the software
   > keyboard.** Gotcha: `registerListener`/`remove_listener` (those exact spellings)
   > must be in a plugin's `COMMANDS` for `addPluginListener` to pass the ACL.
   >
   > **Update:** the `keyboardChange` event bridge was later removed;
   > `--keyboard-height` now comes from `visualViewport` on the web side and the plugin
   > only pins the webview (see TDR 0003's keyboard note).
5. **In-process write-notification seam** (decision 5). A test proves a session save
   reaches the index and the engine's dirty mark without a watcher.
6. **Onboarding + bootstrap** (start fresh, device flow + clone, initial index).
7. **Today + note editing** over the desktop document stack; touch autocomplete;
   flush-on-background; images via the asset protocol.
8. **Tab shell + All tab** (virtualized list, search, filter badges).
9. **Daily V1 parity + new note.** Month header + week strip + Embla carousel; `+` opens
   an untitled note (the 2026-06-12 call removed the V2 capture sheet). Settings sheet and
   note actions; share uses `navigator.share`, verified in the Tauri iOS WKWebView, so no
   native plugin.
10. **Sync wiring** (resume/edit/online triggers, background commit, status pill).
11. **Harden + ship.** Memory pass on a large graph and very large notes,
    resume-after-death check, a11y labels, TestFlight (see `docs/distribution.md`), App
    Store with the review story.
12. **Android** (fast follow): `tauri android init`, Kotlin keyboard half, keystore
    signing, Play submission. No new product surface.

## Acceptance criteria

- `pnpm tauri ios dev` runs from a clean checkout (see
  [the simulator runbook](../contributing/mobile-simulator.md)); desktop is unaffected.
- Start fresh → today's note on disk in `Documents/`, visible in Files; capture appends
  markdown desktop later pulls intact.
- Connect GitHub → clone; edits round-trip phone ↔ desktop.
- **Editing:** edit a note (incl. an autocompleted `[[wiki link]]`) with no markdown
  corruption (smart punctuation and autocorrect included); the edit shows in search and
  backlinks **without a restart** (proves decision 5).
- **No buffer loss:** background mid-edit, kill from the switcher, relaunch: the edit is
  on disk.
- The keyboard never permanently occludes the editor; the caret stays visible (notched
  device, portrait + landscape).
- A conflict never blocks other notes; a lossy note opens protected.
- No `private: true` content leaves the device: mobile v1 makes **no** AI or transcription
  calls; egress is GitHub only.
- TestFlight survives background/resume without a blank webview; App Store review passes
  (or rejection is triaged against TDR 0003's triggers).

## Risks

1. **Editing in WKWebView (the V1-mobile scar), the headline risk.** Spike B before any
   UI; the CM6 rung has independent proof (Obsidian). If both fail, the options are
   native-editor territory that no webview shell fixes, and the mobile approach is
   re-decided. Obsidian's existence makes this unlikely.
2. **Tauri mobile early-adopter risk** (the TDR's bet). Keyboard and lifecycle issues are
   known and mitigated; spike A is a hard gate with a documented fallback.
3. **Editor divergence if CM6 ships:** a second integration to maintain, accepted at the
   step-2 decision and recorded in a TDR addendum; the document stack stays shared.
4. **Cross-compiling the vendored stack** (OpenSSL/libssh2/libgit2; later Android NDK),
   isolated in spike A.
5. **Store review** (4.2 minimal functionality) is low but real for webview shells; the
   demo-graph story is part of step 11.
6. **Clone size on mobile networks.** v1 accepts it with progress UI; shallow/partial
   clone is a follow-up that must not casually fork the desktop sync contract.
7. **Webview memory on huge graphs / large notes.** The step 11 memory pass is the
   checkpoint; pagination and note-size guardrails are the levers.
