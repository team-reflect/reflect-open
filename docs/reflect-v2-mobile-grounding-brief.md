# Reflect V2 Mobile Grounding Brief

**Purpose:** A product-oriented overview of the Reflect V2 mobile app for a mobile-implementation agent: the product model, the inherited V2 constraints, the lessons from V1 mobile, and the shape of the later waves.

**Decision status:** Grounding material, not the source of truth. When this brief conflicts with them, these win: [Plan 19 (mobile companion)](./plans/19-mobile.md), [TDR 0003 (Tauri 2 mobile)](./decisions/0003-mobile-shell.md), [Reflect V2 Product Vision](./reflect-v2-product-vision.md), [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md), [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md), and, for storage and sync, [Plan 21 (iCloud Drive sync)](./plans/21-icloud-drive-sync.md) with its user contract in [iCloud Drive Sync](./icloud-sync.md). The product owner confirmed the section 3 scope calls on 2026-06-12. The brief was last trued up on 2026-07-05, after Plan 21 shipped iCloud Drive as the primary sync backend.

**Primary sources:** [Reflect V1 Mobile Overview](./reflect-v1-mobile-overview.md), Plan 19, TDR 0003, and the V2 decision docs above.

---

## 1. Executive Summary

Reflect V2 mobile is **the same app as desktop, on a phone**, not a second product.

- **One codebase, three platforms.** Mobile is a build target of the Tauri 2 app (`apps/desktop`): the same Rust core (git2 sync, rusqlite/FTS5 index, keychain), the same `@reflect/core`, and the same React frontend behind a lazy platform gate with a mobile surface tree (`src/mobile/`). V1 mobile was a separate Capacitor repo kept alive by rsyncing web code. TDR 0003 records why (the Rust core decides it) and keeps Capacitor as the fallback, with explicit triggers.
- **Same graph, same files.** The phone holds a real markdown workspace (`daily/`, `notes/`, `assets/`, ignored `.reflect/`), visible in the Files app. Its primary home is the app's iCloud Drive container (**iCloud Drive → Reflect → <graph>**), where the OS moves files between iPhone and Mac. The self-managed alternative is the sandbox `Documents/` root, device-only or GitHub-synced. No server, no account, no encryption password. Onboarding is iCloud-first, with keep-on-device and Connect GitHub behind it.
- **Narrow capture-and-edit scope.** Open to today, swipe through days, **edit in place with the real editor**, create notes, lexical search, minimal settings. Plan 19 says a read-only browser is not a shippable v1.
- **The V1 reliability lesson, re-solved locally.** V1's critical capture survived webview death by POSTing to Reflect servers, which V2 forbids. V2 uses flush-on-background with a local commit, raw-first artifacts, and (later) an App Group capture inbox.
- **Mobile must not distort desktop.** Desktop avoids choices that make mobile impossible (libgit2 over system git, SQLite everywhere). Mobile reuses desktop seams: an in-process file-change channel replaces the watcher, the document stack is reused whole, and there is no second write path.

---

## 2. What V2 Mobile Is, and Is Not

### 2.1 Identity

A capture-and-recall companion with one product identity:

1. **Time:** open to today's daily note; page through the chronological spine.
2. **Association:** `[[Wiki Links]]` work everywhere, with touch autocomplete; backlinks stay readable.
3. **Recall:** local lexical search over titles, bodies, and backlinks, instant and offline.

### 2.2 What it is not

- Not a viewer. Editing ships in v1, on desktop's document machinery (sessions, debounced atomic saves, title rename, round-trip protection).
- Not a parity port. No copilot, semantic search, ⌘K palette, CLI sidecar, map, or publishing. The container can hold several graphs (the settings sheet switches), but only one is open at a time, with no desktop-style chooser.
- Not a separate codebase, schema, or design system.
- Not a cloud client. The phone is a peer with its own copy. The app's only network egress is GitHub sync; iCloud sync happens OS-side.

---

## 3. First-Release Scope

Plan 19 defines the binding scope. Summary, with the 2026-06-12 product calls:

| Capability | First mobile release | Notes |
| --- | --- | --- |
| Today + day pager, daily notes | **In** | Default screen. V1 design parity: month header, week strip, swipeable day carousel (Embla), in a Daily / All tab shell. |
| Full editing (meowdown) | **In** | Hard requirement. The on-device gate spike (Plan 19 step 2) passed; the CM6 fallback was never needed. |
| New note (`+` button) | **In** | **No capture sheet**: the daily note is the capture surface. `+` opens a fresh untitled note via desktop's ⌘N flow. |
| All notes + lexical search (FTS5) | **In** | Same index and getters as desktop. Search sits in the All tab with filter badges. |
| Note actions (pin, share, trash) | **In** | Full V1 parity: pin (frontmatter flag), share via `navigator.share` (works in the Tauri iOS WKWebView, no plugin), trash to `.reflect/trash/`. |
| Settings sheet | **In** | Graph name, storage (iCloud Drive / This device), **Switch graph**, note count, GitHub connect/disconnect, sync status, version. |
| iCloud Drive sync (Plan 21) | **In** | Primary transport. The OS moves files; conflicts resolve on-device (section 6). iCloud and Git are exclusive per graph. |
| GitHub sync (device flow, HTTPS) | **In** | For on-device graphs. Foreground-only: on resume, after debounced edits, and on network regain. |
| Onboarding: iCloud-first | **In** | Lists container graphs (one-tap open) or stores fresh notes there; **Keep notes on this device** and **Sync with GitHub instead** behind it. Roots re-derive each launch; the iCloud graph persists by *name*. |
| Conflict **resolution** UI | **Out of scope** | Conflicts resolve automatically (the ladder for notes, conflict copies for other files). |
| Audio memos | **Later wave** | First post-release wave, reusing desktop's raw-first + async BYOK transcription; OS entry points (widget, Siri, Live Activity) come with it. |
| Share-sheet capture | **Later wave** | Waits until a mobile share target can reuse the Plan 11 capture envelope/inbox. Needs App Group ingestion. |
| AI copilot (BYOK) | **Later wave** | Architecture holds (keys in the iOS keychain via the same secrets module); the surface is deferred. |
| Semantic search / embeddings | **Later** | `fastembed`/ORT is desktop-only; mobile is lexical-first. |
| Tasks, widgets, push, background sync | **Out of v1** | Plan 19's out-of-scope list; tasks follow desktop's Plan 18. |
| Android | **Fast follow** | Same architecture, last step of Plan 19 (Kotlin keyboard plugin, Play submission). |

The later-wave rows still bind v1: the workspace layout, privacy enforcement points, and native-target provisioning must not need rework when audio and share-sheet capture arrive (section 7).

---

## 4. Inherited V2 Decisions That Bind Mobile

Settled in the decision docs, not negotiable on mobile:

- **Markdown is the source of truth.** Notes are `.md` files, attachments live under `assets/`, and the workspace is visible in the Files app.
- **SQLite under `.reflect/` is a rebuildable projection**, except the durable `chat_*` tables. `.reflect/` is per-device and never synced, so the phone builds its own index and desktop chat history does not appear. Mobile deletes notes to sync-ignored `.reflect/trash/`, not the OS trash.
- **No Reflect-hosted APIs.** Every V1 mobile flow that used a Reflect endpoint (share extension, link enrichment, audio upload/transcription, OAuth token exchange, push) is gone in that form. In mobile v1, the only external calls go to GitHub.
- **BYOK AI with `private: true` as a hard block.** Mobile v1 makes no AI or transcription calls at all, by acceptance criterion. When they arrive, they use keys from the iOS keychain, and `private: true` is enforced at every call site, including the capture inbox boundary.
- **Two sync backends, one per graph.** Plan 21 (2026-07-04) superseded "file-sync providers are unsupported by design": iCloud Drive is now the *primary* backend, made safe by on-device resolution of `NSFileVersion` conflicts over per-device shadow bases (notes merged word by word, other files kept as conflict copies). Git (GitHub over HTTPS with device-flow tokens, via libgit2 since iOS has no system git) is the self-managed path. Two invariants survive: **one sync method per graph is recommended**, and **`.git/`/`.reflect/` never ride a file-sync provider**.
- **Secrets in the OS keychain.** The GitHub token (later AI keys) goes in the iOS keychain via the same `keyring` module (`apple-native`), never in markdown, Git, or `.reflect/`.
- **Design system and conventions.** Same `design-system/` tokens (including safe-area tokens), Tailwind + shadcn, AGENTS.md conventions, MIT core. The mobile shell and Swift plugins are public code.

---

## 5. Architecture Orientation

Plan 19 owns the detail. The mental model:

- **Shell:** Tauri 2's iOS target, generated from `ios.project.yml` (XcodeGen) into `gen/apple/`. Template edits need `tauri ios init` regeneration. Platform overlays drop the CLI sidecar. App identity is `app.reflect.ios`, product name "Reflect".
- **Rust crate:** builds for `aarch64-apple-ios`, with desktop-only capabilities target-gated (watcher, embeddings, OS trash, window-state, updater). Index, document, and fs modules need no fork.
- **Frontend:** one bundle with a lazy platform gate (`PlatformRoot`) and a mobile tree under `src/mobile/`: screens over a subset of the typed `Route` union, no URL router. Desktop chrome stays in desktop-only chunks.
- **No notify watcher on mobile.** Every local write emits its file-change batch in-process (`emitFileChanges`). Reindex, query invalidation, sync dirty-marking, and editor reconciliation all hang off that one channel. For iCloud graphs, an `NSMetadataQuery` watch is the *external*-change source: it feeds the same channel, requests downloads for non-current items at once (iOS never downloads unasked), and carries the conflict signal. One in-process channel plus one container watch keeps mobile from growing its own index or sync logic.
- **Keyboard:** Tauri iOS has no keyboard handling, so a first-party Swift plugin (`plugins/tauri-plugin-keyboard`) streams keyboard height to JS and keeps the caret above the keyboard. V1's native accessory bar (class-swizzling) was brittle and is **not** ported. The formatting toolbar is **webview-drawn** (Plan 19 decision 8), placed by the plugin's height events.
- **Lifecycle:** iOS suspends fast and can kill the WebContent process. On background, flush open documents and settings and make a local commit (never a push). On resume, run a sync cycle and survive a dead webview. A relaunch lands on the last route with no buffer loss.

### The two existential gates (both passed)

Plan 19 front-loaded its risk into two timeboxed spikes, and nothing else proceeded until both passed:

1. **The crate on iOS** (spike A, simulator, 2026-06-12: keychain, FTS5, file IO, libgit2 all green; physical-device check remains).
2. **Editing on a real iPhone** (spike B: **meowdown passed**, CM6 fallback never needed). Editing in WKWebView was V1 mobile's deepest scar (focus, selection, keyboard timing, patched selection crashes). The lessons live in the touch editor: `spellCheck=false` pins iOS smart punctuation, the shell yields by height so popups end at the keyboard, and WKScrollView's caret-reveal scroll is pinned out natively.

---

## 6. Sync on Mobile

The heart of the mobile product. A graph uses exactly one of two transports:

- **iCloud Drive (primary).** The OS moves the files; the app handles intake and conflicts. The metadata query reports external changes and nudges downloads at once (that nudge is what lands a Mac edit on an open iPhone in seconds), and resume polls pending downloads. Remaining latency is iCloud's own.
- **Conflicts mostly resolve themselves.** `NSFileVersion` conflicts go through the deterministic ladder (identical/whitespace → three-way merge over a shadow base → key-wise frontmatter → daily append-union → word-level merge). Both devices produce *byte-identical* results, so they converge instead of ping-ponging. No conflict reaches the user; other files keep a conflict copy. The once-canonical daily append/append conflict now **auto-merges**, but keep it as a first-class test scenario.
- **Git (self-managed): same engine, same contracts.** libgit2 commit/fetch/merge, the same ladder, the no-loop invariant. Pull-applied changes go through `onRemoteChanges`. Foreground-only; no BGTaskScheduler. The plain-language status ("Backed up / Syncing / Offline") is more prominent than on desktop.
- **Capture latency is the contract.** "Open app, type a thought, lock phone" must always be safe: local writes never wait on the network, and flush-on-background covers the save debounce. Plan 19's acceptance criteria pin this (kill the app mid-debounce; the edit is on disk).
- **First sync is onboarding.** iCloud downloads on demand, with no clone step. Git clones a years-old graph over cellular in the foreground: slow clones with progress UI are accepted, and shallow/partial clone is the follow-up lever.

---

## 7. Lessons Carried from V1 Mobile

From the [V1 Mobile Overview](./reflect-v1-mobile-overview.md):

### 7.1 Preserved

- **Open-to-today with day paging.** V1's daily carousel was the right model. Ported flows match V1's interactions unless deliberately decided otherwise.
- **Few surfaces.** V1 succeeded with three tabs and almost no chrome. Resist adding desktop surfaces.
- **Full local projection = offline trust.** Everything readable and searchable offline.
- **Editing in WKWebView is the headline risk.** That is why Plan 19 gated the editor on a real device before building screens, with iOS text-input hygiene (smart punctuation vs. `[[`, autocorrect artifacts) in the gate.
- **Webview storage is not stable ground.** V1 needed webview-crash detection and an IndexedDB workaround for an iOS beta. In V2, canonical state lives in markdown + SQLite below the webview, and the lifecycle assumes the WebContent process can die at any time.

### 7.2 Re-solved (V1's answer is forbidden or was brittle)

- **Background capture without a server.** V1's share extension and voice memos worked with the app dead *because a server got the payload*. V2's later waves use a local App Group capture inbox: an extension writes pending items (raw audio, shared URLs/text), and the main app ingests them into markdown on next launch and syncs. Extensions never touch the Git repo or SQLite. `private: true` applies at the inbox boundary.
- **Transcription.** V1 transcribed server-side. V2 reuses desktop's decision: the raw recording is the durable, sync-safe artifact, with async BYOK transcription, explicit privacy UX, and `private: true` lockout.
- **The native accessory toolbar.** V1's swizzling was brittle. The keyboard-height plugin is the stable primitive, and the webview-drawn toolbar on top of it worked.
- **Onboarding.** V1 gated entry behind auth → graph selection → encryption unlock → initial Firestore sync. V2 has none of that: open or create an iCloud graph, keep notes on-device, or connect GitHub, then land on Today. Do not rebuild V1's loading-gate machinery.

### 7.3 Dropped

Push notifications (no server), OAuth token exchange, Firebase, App-Store-tester backdoors, the separate mobile repo and its rsync sharing, and Capacitor (kept in TDR 0003 as the fallback if Tauri mobile's gaps prove fatal).

---

## 8. Feature Surface Mapping (V1 Mobile → V2 Mobile)

| V1 mobile capability | V2 mobile direction |
| --- | --- |
| Daily tab (swiper carousel, calendar strip) | **v1**: Today screen + day pager |
| Full rich editor + native keyboard toolbar | **v1**: meowdown + keyboard-height plugin; webview-drawn toolbar (Plan 19 decision 8) |
| All Notes list + FTS search | **v1**: virtualized list + FTS5 search |
| Quick capture into today | **v1**: the daily note itself; `+` = new untitled note (the append-to-today sheet was cut on 2026-06-12) |
| Auth (Apple/Google/OTP), encryption unlock | **Dropped**: no accounts, no E2EE |
| Graph switcher | **v1**: the settings sheet switches container graphs and the on-device root; one graph open at a time |
| Trash / delete | **v1**: to `.reflect/trash/` (recoverable, sync-ignored) |
| Pin, publish, share-as-text note actions | **v1**: pin + share + trash; publishing stays deferred product-wide |
| JSON export via share sheet | Superseded: the workspace is Files-visible markdown |
| Tasks tab | Post-release, follows desktop Plan 18 |
| Search-grounded AI chat | Later wave, with the copilot |
| Voice memos + widget/Siri/Live Activity | Later wave (raw-first + BYOK transcription, OS entry points with it) |
| Share extension | Later wave, reusing the Plan 11 capture envelope; needs an App Group inbox |
| Note history UI | Git history exists; UI deferred product-wide |
| Push notifications | Dropped: no server |
| Deep links (`reflect://`) | Not a v1 surface; revisit with the command registry |
| TestFlight automation, timestamp build numbers | **Done**: see [distribution.md](./distribution.md) |

---

## 9. Risk Register (Mobile-Specific)

Aligned with Plan 19's risks, by product impact:

1. **Editing quality in WKWebView**: **retired** by spike B. The sharp edges found are pinned in code (smart-punctuation gating, keyboard-height yielding, caret-scroll suppression). Watch for regressions on iOS updates.
2. **Tauri mobile early-adopter risk**: no marquee consumer iOS app ships Tauri mobile. Known keyboard and lifecycle gaps are budgeted; unknowns are not. Capacitor is the documented fallback.
3. **Cross-compiling the vendored stack** (OpenSSL/libssh2/libgit2, later the Android NDK): workable but fiddly. Example: cargo link directives do not reach the Xcode link, so libgit2's zlib/iconv are in `ios.project.yml`.
4. **iCloud propagation opacity**: latency and delivery are OS-controlled. The app is at the latency floor (live download nudges), so remaining slowness has no app-side lever. The two-device conflict matrix is the standing check for every ladder or watch change.
5. **App Store review**: 4.2 minimal-functionality risk is low for a local-first editor, but nonzero for webview shells. The reviewer story (usable with no account, demo graph) ships with submission.
6. **Clone size on mobile networks** (Git): accepted with progress UI; shallow/partial clone is the lever. iCloud downloads on demand.
7. **Webview memory on huge graphs or notes**: the step-11 memory pass is the checkpoint, note-size guardrails the lever. On iCloud the graph is fully downloaded by policy (the index needs the bytes), so "the graph fits on the phone" is an assumption, not a guarantee.

---

## 10. UX Model

Desktop is keyboard-native; mobile translates that rather than importing it:

- **Touch-native, capture-first.** Thumb-reachable core actions, search as a visible surface, and the keyboard never hides the caret. No ⌘K palette in v1; iPad hardware-keyboard users use visible affordances.
- **Minimal UI, doubly.** Six screens, a tab/stack shell, a sync-status pill. Settings: storage, switch graph, GitHub, version.
- **Same visual language.** Design-system tokens, safe-area layout (`viewport-fit=cover`), 16px minimum input font (blocks iOS auto-zoom), dark mode. iPad is "a big phone" in v1.
- **Plain-language sync.** "Backed up / Syncing / Offline", never commits, branches, or merges.

---

## 11. Definition of Success (First Mobile Release)

Plan 19's acceptance criteria bind. At product level, a user can:

1. Install the iOS app and, in minutes, open the graph already in iCloud Drive, or start fresh there, keep notes on-device, or connect GitHub.
2. See today's daily note instantly, offline or online.
3. Edit any note, including a `[[wiki link]]` via autocomplete, with no markdown corruption, and find the edit in search and backlinks without restarting.
4. Lock the phone mid-thought and lose nothing, even if iOS kills the app.
5. See the edit on their Mac after the next sync, and when the rare conflict happens, choose what to keep on the phone while everything else keeps syncing.
6. Open the Files app and see their notes as portable markdown.

The codebase succeeds if audio memos, share-sheet capture, and the AI copilot can arrive later **without** re-architecting the workspace, sync, privacy enforcement, or navigation.

---

## 12. Open Questions

1. **App Group + capture-inbox schema** for the audio/share waves: layout, ingest semantics, `private: true` at the boundary, and when to provision the App Group and extension targets (cheap early, annoying to retrofit, not needed for v1).
2. **Semantic search graduation:** what battery/storage/latency evidence gates local embeddings on iOS? Does sqlite-vec/fastembed ever run there?
3. **AI-assisted conflict resolution:** Plan 21 defers it; the ladder would hand AI the same base/local/remote triple. How does mobile apply resolutions that need BYOK calls?
4. **iPad posture:** how long does "big phone" hold before a two-pane layout is worth it?
5. **Deep links and the command registry:** when automation (shortcuts, widgets) arrives, does `reflect://` map onto desktop's typed command layer?
6. **Graph size on iCloud:** full download plus O(all-notes) watch diffing is fine today. What size forces delta intake or selective download?

Closed since the first draft: the daily append/append merge (Plan 21's append-union rung) and the webview-drawn toolbar (Plan 19 decision 8).

---

## 13. Bottom Line for the Mobile Agent

> The same local-first markdown app, recompiled for the pocket: today's note on open, real editing under a keyboard that behaves, instant offline search, and sync behind three plain words (iCloud by default, Git for the self-managed), with voice, share-sheet, and AI waves arriving on the same foundations.

Build from what makes V2 distinct: one codebase, markdown visible in the Files app, a rebuildable per-device index, deterministic on-device conflict resolution, no servers, no accounts, and `private: true` as a hard line. Apply V1 mobile's hardest lessons: gate the editor on a real device first, keep canonical state below the webview, and make "lock the phone mid-thought" always safe.

Plan 19 is the route; this brief is the map of why.
