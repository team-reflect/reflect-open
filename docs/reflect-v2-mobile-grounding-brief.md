# Reflect V2 Mobile Grounding Brief

**Purpose:** Provide a broad, product-oriented overview of what the Reflect V2 mobile app should be, so a mobile-implementation agent understands the product model, the inherited V2 constraints, the lessons from V1 mobile, and the shape of the later waves — before and while working through the implementation plan.

**Decision status:** This brief is grounding material, not the source of truth. The implementation plan is [Plan 19 (mobile companion)](./plans/19-mobile.md) and the shell decision is [TDR 0003 (Tauri 2 mobile)](./decisions/0003-mobile-shell.md) — when this brief conflicts with either, they win, along with [Reflect V2 Product Vision](./reflect-v2-product-vision.md), [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md), [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md), and — for storage and sync — [Plan 21 (iCloud Drive sync)](./plans/21-icloud-drive-sync.md) with its user contract in [iCloud Drive Sync](./icloud-sync.md). First-release scope calls recorded in section 3 were confirmed with the product owner on 2026-06-12; the brief was last trued up on 2026-07-05, after Plan 21 shipped iCloud Drive as the primary sync backend.

**Primary sources:** [Reflect V1 Mobile Overview](./reflect-v1-mobile-overview.md) (from exploration of the `reflect-mobile` repo), Plan 19 and TDR 0003, and the V2 decision docs above.

---

## 1. Executive Summary

Reflect V2 mobile is **the same app as desktop, on a phone** — not a second product.

- **One codebase, three platforms.** V2 mobile is a build target of the existing Tauri 2 app (`apps/desktop`): the same Rust core (git2 sync, rusqlite/FTS5 index, keychain), the same `@reflect/core` business logic, the same React frontend behind a lazy platform gate with a mobile surface tree (`src/mobile/`). This is the single largest improvement over V1, where mobile was a separate Capacitor repo kept alive by rsyncing code from the web app. TDR 0003 records why (the Rust core is the deciding asset) and names Capacitor as the documented fallback with explicit triggers.
- **Same graph, same files.** The phone holds a real markdown workspace (`daily/`, `notes/`, `assets/`, ignored `.reflect/`) — visible in the iOS Files app, so portability holds on mobile. The primary home is the app's iCloud Drive container (**iCloud Drive → Reflect → <graph>** in Files/Finder, Plan 21), where the OS itself moves the markdown between iPhone and Mac; the app-sandbox `Documents/` root (device-only, optionally GitHub-synced through the same device-flow + libgit2 layer) is the self-managed alternative. There is no server, no account, no encryption password: onboarding is iCloud-first — open a graph already in the container, or store fresh notes there — with keep-on-device and Connect-GitHub behind it.
- **Capture-and-edit product scope, deliberately narrow.** Open to today's daily note, swipe through days, **edit notes in place with the real editor**, quick-capture into today, create notes, lexical search, minimal settings. Editing is a hard requirement — Plan 19 is explicit that a read-only browser is not a shippable v1.
- **The V1 reliability lesson carries over, re-solved locally.** V1 mobile's defining design was that critical capture paths survived webview death — but it achieved that by POSTing to Reflect servers, which V2 forbids. V2's equivalents are local: flush-on-background with a local commit, raw-first artifacts, and (in later waves) an App Group capture inbox instead of a server.
- **Mobile must not distort desktop.** Desktop avoids choices that make mobile impossible (libgit2 over system git, SQLite everywhere), and mobile reuses desktop seams rather than forking them — the in-process file-change channel replaces the watcher, the document stack is reused wholesale, and there is no second write path.

---

## 2. What V2 Mobile Is — and Is Not

### 2.1 Identity

A capture-and-recall companion to the desktop app, sharing one product identity:

1. **Time:** open to today's daily note; page through the chronological spine.
2. **Association:** `[[Wiki Links]]` work everywhere, including autocomplete under touch; backlinks stay readable on the phone.
3. **Recall:** local lexical search over titles, bodies, and backlinks — instant and offline.

### 2.2 What it is not

- Not a viewer. Editing ships in v1, on the same document machinery as desktop (sessions, debounced atomic saves, title rename, round-trip protection).
- Not a parity port. No copilot, no semantic search, no ⌘K palette, no CLI sidecar, no map, no publishing. (The container can hold several graphs — the settings sheet switches between them — but only one graph is open at a time; there is no desktop-style chooser.)
- Not a separate codebase, schema, or design system.
- Not a cloud client. The phone is a peer device operating on its own copy of the graph; network egress *from the app* is GitHub sync only — iCloud document sync happens OS-side, below the app.

---

## 3. First-Release Scope

Plan 19 defines the binding scope. Summarized, with the product-owner calls of 2026-06-12 noted where they refine sequencing:

| Capability | First mobile release | Notes |
| --- | --- | --- |
| Today + day pager, daily notes | **In** | The default screen; open-to-today. V1 design parity (product call 2026-06-12): month header + week calendar strip + touch-swipeable day carousel (Embla), in a Daily / All tab shell. |
| Full editing (meowdown) | **In** | Hard requirement. The on-device gate spike (Plan 19, decision 7 / step 2) passed with meowdown; the CM6 fallback rung was never needed. |
| New note (`+` button) | **In** | V1 parity (product call 2026-06-12): there is **no capture sheet** — the daily note is the capture surface; `+` opens a fresh untitled note via desktop's ⌘N seed/ghost-title flow. |
| All notes + lexical search (FTS5) | **In** | Same index schema and getters as desktop; search embedded in the All tab with filter badges, V1-style. |
| Note actions (pin, share, trash) | **In** | Product call 2026-06-12: full V1 parity — pin/unpin (frontmatter flag), share via the Web Share API (`navigator.share`, verified working in the Tauri iOS WKWebView — no native plugin needed), trash to `.reflect/trash/`. |
| Settings sheet | **In** | V1's avatar spot: graph name, storage (iCloud Drive / This device), **Switch graph** (other container graphs + the on-device root), note count, GitHub connect/disconnect, sync status, version. |
| iCloud Drive sync (Plan 21) | **In** | The primary transport: the graph lives in the app's iCloud container; the OS moves files; conflicts resolve on-device through the deterministic ladder (see section 6). iCloud and a Git remote are mutually exclusive per graph. |
| GitHub sync (device flow, HTTPS) | **In** | For self-managed (on-device) graphs. Foreground-only; cycle on resume, after debounced edits, and on network regain. |
| Onboarding: iCloud-first | **In** | Lists every graph already in the container (one-tap open) or stores fresh notes there; **Keep notes on this device** and a **Sync with GitHub instead** link behind it. Roots re-derived every launch; the chosen iCloud graph persists by *name*. |
| Conflict **resolution** UI | **In** | Conflicted notes open protected with the same raw-marker mine/theirs/both resolution actions as desktop. |
| Audio memos | **Later wave** | Product owner: first post-release wave, reusing desktop's raw-first + async BYOK transcription pipeline; OS entry points (widget, Siri, Live Activity) come with it. |
| Share-sheet capture | **Later wave** | Product owner: defer until the mobile share-target plugin can reuse the Plan 11 capture envelope/inbox model. Desktop Chrome capture has shipped; mobile still needs App Group ingestion. |
| AI copilot (BYOK) | **Later wave** | Architecture holds (keys would live in the iOS keychain via the same secrets module); the surface is deferred. |
| Semantic search / embeddings | **Later** | `fastembed`/ORT is desktop-only; mobile is lexical-first per the indexing strategy. |
| Tasks, widgets, push, background sync | **Out of v1** | Per Plan 19's explicit out-of-scope list; tasks follow desktop's Plan 18. |
| Android | **Fast follow** | Same architecture, last step of Plan 19 (Kotlin keyboard-plugin half, Play submission). No new product surface. |

The later-wave rows matter in v1 even though they ship nothing: the workspace layout, privacy enforcement points, and native-target provisioning should not need rework when audio and share-sheet capture arrive (section 7).

---

## 4. Inherited V2 Decisions That Bind Mobile

Settled in the decision docs; not mobile-negotiable:

- **Markdown is the source of truth.** Notes are `.md` files; attachments are normal files under `assets/`. On mobile the workspace is additionally Files-app visible — the user can see, copy, and back up their markdown on device.
- **SQLite under `.reflect/` is a rebuildable projection** — with the durable `chat_*` exception. `.reflect/` is per-device and never synced: the phone builds its own index, and desktop chat history does not appear on mobile. Mobile adds one graph-local convention: deleted notes move to sync-ignored `.reflect/trash/` instead of the OS trash.
- **No Reflect-hosted APIs.** Every V1 mobile flow that depended on a Reflect endpoint (share extension, link enrichment, audio upload/transcription, OAuth token exchange, push) is unavailable in that form. External calls go directly to user-approved providers; in mobile v1 that means GitHub only.
- **BYOK AI with `private: true` as a hard block.** Mobile v1 sidesteps the question by making no AI or transcription calls at all — an acceptance criterion, not an accident. When audio and AI arrive, provider calls use user keys from the iOS keychain and `private: true` is enforced at every call site, including the capture inbox boundary.
- **Two sync backends, never both on one graph.** The original "file-sync providers are unsupported by design" rule was **superseded by Plan 21** (2026-07-04): iCloud Drive is now the *primary* sync backend, made safe by first-class conflict handling — `NSFileVersion` conflict versions resolved on-device through a deterministic ladder over per-device shadow bases, with every consumed version archived first (see [icloud-sync.md](./icloud-sync.md)). Git sync (GitHub over HTTPS with device-flow tokens; libgit2, since system git is impossible on iOS) remains the self-managed path. The load-bearing residue of the old rule survives as two invariants: **a graph syncs through iCloud *or* a Git remote, never both** (two engines merging the same files fight each other), and **`.git/`/`.reflect/` never ride a file-sync provider** (they're always sync-excluded).
- **Secrets in the OS keychain.** The GitHub token (and later AI keys) go in the iOS keychain via the same `keyring` module (`apple-native` covers macOS and iOS); never in markdown, Git, or `.reflect/`.
- **Design system and conventions.** Same `design-system/` tokens (including safe-area tokens), Tailwind + shadcn, AGENTS.md conventions, MIT open-source core — the mobile shell and its Swift plugins are public, critiqued code.

---

## 5. Architecture Orientation

Plan 19 owns the implementation detail; this is the mental model:

- **Shell:** Tauri 2's iOS target generated from `ios.project.yml` (XcodeGen) into `gen/apple/`. Template edits require `tauri ios init` regeneration. The CLI sidecar is excluded from mobile bundles by the platform overlays. App identity is `app.reflect.ios` / product name "Reflect".
- **Rust crate:** compiles to `aarch64-apple-ios` with desktop-only capabilities target-gated (watcher, embeddings, OS trash, window-state, updater). The index, document model, and fs modules need no mobile fork. Gate spike A passed on the simulator on 2026-06-12 (keychain, FTS5, file IO, libgit2 probes all green); physical-device verification remains.
- **Frontend:** one bundle, a lazy platform gate at the root (`PlatformRoot`), and a mobile surface tree under `src/mobile/` — screens over a subset of the typed `Route` union, no URL router. Desktop chrome (sidebars, titlebar, palette) stays in desktop-only chunks. The Today screen already mounts the real editor through the shared save pipeline (verified end-to-end on the simulator).
- **No notify watcher on mobile:** every local write emits its file-change batch in-process (`emitFileChanges` — the seam the backup controller already used for pull-applied writes). Incremental reindex, query invalidation, sync dirty-marking, and open-editor reconciliation all hang off that one channel. For iCloud graphs, an `NSMetadataQuery` watch (Plan 21) is the *external*-change source: it feeds the same channel when the OS lands files behind the app's back, requests downloads for non-current items the moment they're reported (iOS never downloads content unasked), and carries the conflict signal. This split — one in-process channel, one container watch — is the contract that keeps mobile from growing its own index or sync logic.
- **Keyboard:** Tauri iOS has no keyboard handling, so a small first-party Swift plugin (`plugins/tauri-plugin-keyboard`) streams keyboard height to JS and keeps the caret visible above the keyboard. Notably, V1 mobile's native accessory-bar approach (class-swizzling) is deliberately **not** ported — it was brittle; the formatting toolbar shipped **webview-drawn** (Plan 19 decision 8), positioned via the plugin's height events.
- **Lifecycle:** iOS suspends quickly and can kill the WebContent process. The contract: flush open documents + settings and make a local commit on background (never a push); on resume, run a sync cycle and survive a dead webview. A relaunch must land back on the last route with no buffer loss.

### The two existential gates (both passed)

Plan 19 front-loaded its risk into two timeboxed spikes, and nothing else proceeded until both passed:

1. **The crate on iOS** (spike A — passed on the simulator 2026-06-12: keychain, FTS5, file IO, libgit2 probes all green).
2. **Editing on a real iPhone** (spike B — **meowdown passed**; the CM6 fallback rung was never needed). Editing markdown in WKWebView was V1 mobile's deepest scar (ProseMirror focus/selection/keyboard timing, patched selection crashes); the surviving lessons are encoded in the touch editor surface — `spellCheck=false` pins iOS smart punctuation, the shell yields by height so popups end at the keyboard, and WKScrollView's caret-reveal scroll is pinned out natively.

---

## 6. Sync on Mobile

The heart of the mobile product, and where mobile differs most from desktop in daily feel. Since Plan 21 there are two transports; a graph uses exactly one:

- **iCloud Drive is the primary transport.** The OS moves the markdown; the app's job is intake and conflicts. The `NSMetadataQuery` watch reports external changes live, nudges downloads for non-current items the moment they appear (iOS never downloads unasked — this nudge is what makes a Mac edit land on an open iPhone in seconds), and the resume path polls pending downloads so notes appear as they arrive. Residual latency is iCloud's own propagation, which the app can't control.
- **Conflicts mostly resolve themselves.** iCloud edit conflicts surface as `NSFileVersion` conflict versions, and the deterministic ladder (identical/whitespace → three-way merge over a per-device shadow base → key-wise frontmatter → daily append-union → labeled markers) resolves them on-device — both devices independently produce *byte-identical* results, so they converge instead of ping-ponging. Every consumed version is archived to `.reflect/conflict-archive/` first. Only the marker fallback reaches the user, as a protected note with the same mine/theirs/both resolution actions as desktop. The once-canonical daily append/append conflict now **auto-merges** (the append-union rung — Plan 12's "future work" merge driver, shipped by Plan 21); keep it as a first-class test scenario anyway.
- **Git is the self-managed transport, same engine, same contracts.** libgit2 commit/fetch/merge, conflict markers, the no-loop invariant — unchanged. Pull-applied changes flow through the existing `onRemoteChanges` reindex path. Foreground-only: cycles on resume, after debounced edits, and on network regain; background sync (BGTaskScheduler) stays out. The plain-language status surface ("Backed up / Syncing / Needs review") is more prominent on mobile than desktop.
- **Capture latency is the contract** on both transports. "Open app, type a thought, lock phone" must always be safe: local writes never block on the network; flush-on-background protects the save debounce window. Plan 19's acceptance criteria pin this (kill the app mid-debounce; the edit is on disk).
- **First sync is onboarding.** For iCloud, opening a container graph downloads content on demand (with the nudge-and-poll loop above) — no clone step. For Git, cloning a years-old graph with assets over cellular, foregrounded, is still the first experience: slow clones with progress UI are accepted; shallow/partial clone remains the follow-up lever.

---

## 7. Lessons Carried from V1 Mobile

From the [V1 Mobile Overview](./reflect-v1-mobile-overview.md), translated into V2 guidance:

### 7.1 Preserved (and already reflected in Plan 19)

- **Open-to-today with day paging.** V1's daily carousel was the right mobile mental model; V2's Today screen + day pager is its descendant. Ported flows should match V1's interaction patterns unless deliberately decided otherwise.
- **Capture-first surface count.** V1 succeeded with three tabs and almost no chrome. V2's screen list (Today, note, all notes, search, capture, settings) holds the same line; resist accreting desktop surfaces.
- **Full local projection = offline trust.** Everything readable and searchable offline, always.
- **Editing in WKWebView is the headline risk.** V1's editor pain (focus, selection, keyboard timing, a patched y-prosemirror selection crash) is why Plan 19 gates the editor on a real device before building screens, and why iOS text-input hygiene (smart punctuation vs. `[[` syntax, autocorrect artifacts) is part of the gate.
- **Webview storage is not stable ground.** V1 shipped webview-crash detection and an iOS-beta workaround for broken IndexedDB. V2's posture: canonical state lives in markdown + SQLite below the webview; the lifecycle contract assumes the WebContent process can die at any time.

### 7.2 Re-solved (V1's answer is forbidden or was brittle)

- **Background capture without a server.** V1's share extension and voice memos worked when the app was dead *because a server received the payload*. The V2 equivalent for the later waves is local: a share-target/extension writes pending items (raw audio, shared URLs/text) into an App Group container as a capture inbox; the main app ingests into markdown on next launch and syncs. Extensions must not touch the Git repo or SQLite directly. `private: true` enforcement applies at the inbox boundary.
- **Transcription.** V1 transcribed server-side after upload. The V2 audio wave reuses desktop's decision: raw-first recordings are the durable, sync-safe artifact; async BYOK cloud transcription with explicit privacy UX and `private: true` lockout.
- **The native accessory toolbar.** V1's signature editor affordance was a native keyboard accessory bar — but its implementation (input-accessory swizzling) was brittle, and Plan 19 explicitly did not port it. The keyboard-height plugin is the stable primitive, and the formatting toolbar shipped **webview-drawn** on top of it — the re-solve worked.
- **Onboarding.** V1 mobile gated entry behind account auth → graph selection → encryption unlock → initial Firestore sync. V2 has no accounts and no encryption password: open (or create) an iCloud graph, keep notes on-device, or connect GitHub — then land on Today. Most of V1's loading-gate machinery simply has no V2 equivalent — don't rebuild it.

### 7.3 Dropped

Push notifications (no server), OAuth token exchange, Firebase everything, App-Store-tester backdoors, the separate mobile repo and its rsync code-sharing, and Capacitor itself — though TDR 0003 keeps Capacitor as the documented fallback if Tauri mobile's gaps prove fatal.

---

## 8. Feature Surface Mapping (V1 Mobile → V2 Mobile)

| V1 mobile capability | V2 mobile direction |
| --- | --- |
| Daily tab (swiper carousel, calendar strip) | **v1**: Today screen + day pager |
| Full rich editor + native keyboard toolbar | **v1**: meowdown + keyboard-height plugin; formatting toolbar webview-drawn (shipped, Plan 19 decision 8) |
| All Notes list + FTS search | **v1**: virtualized list + FTS5 search screen |
| Quick capture into today | **v1**: the daily note itself (open-to-today + editing); `+` = new untitled note — the V2 append-to-today sheet was removed by the 2026-06-12 product call |
| Auth (Apple/Google/OTP), encryption unlock | **Dropped** — no accounts, no E2EE; onboarding = iCloud graph / keep on device / Connect GitHub |
| Graph switcher | **v1** — the settings sheet switches between container graphs and the on-device root (Plan 21); one graph open at a time |
| Trash / delete | **v1** — to graph-local `.reflect/trash/` (recoverable, sync-ignored) |
| Pin, publish, share-as-text note actions | **v1**: pin + share + trash (product call 2026-06-12); publishing stays deferred product-wide |
| JSON export via share sheet | Superseded: the workspace is Files-app-visible markdown |
| Tasks tab | Post-release, follows desktop Plan 18 |
| Search-grounded AI chat | Later wave, with the copilot |
| Voice memos + widget/Siri/Live Activity | Later wave (raw-first + BYOK transcription; OS entry points with it) |
| Share extension | Later wave, reusing the shipped Plan 11 capture envelope; App Group inbox still needed |
| Note history UI | Git history exists; history UI deferred product-wide |
| Push notifications | Dropped — no server |
| Deep links (`reflect://`) | Tauri's deep-link plugin exists; not a v1 surface — revisit with the command registry |
| TestFlight automation, timestamp build numbers | **Done** — `pnpm release:ios` + the TestFlight workflow ([docs/ios-testflight.md](./ios-testflight.md)), timestamp `CFBundleVersion`s carried over |

---

## 9. Risk Register (Mobile-Specific)

Aligned with Plan 19's risks, ordered by product impact:

1. **Editing quality in WKWebView** — was the headline risk by construction; **retired**: spike B passed with meowdown on device (the CM6 rung was never needed), and the sharp edges found on the way are pinned in code (smart-punctuation gating, keyboard-height yielding, caret-scroll suppression). Regressions here remain the thing to watch on iOS updates.
2. **Tauri mobile early-adopter risk** — no marquee consumer iOS app ships Tauri mobile today; keyboard and lifecycle gaps are known and budgeted, unknown unknowns are not. Capacitor fallback documented with triggers.
3. **Cross-compiling the vendored stack** (OpenSSL/libssh2/libgit2; later Android NDK) — known-workable but fiddly; isolated in spike A. One landed example: cargo link directives don't reach the Xcode link, so libgit2's zlib/iconv live in `ios.project.yml`.
4. **iCloud propagation opacity** — the primary transport's latency and delivery are OS-controlled and unobservable beyond the metadata query; the app is at the paradigm's latency floor (live download nudges), so remaining slowness has no app-side lever. The two-device conflict matrix is the standing verification burden for every change to the ladder or watch.
5. **App Store review** — 4.2 minimal-functionality risk is low for an offline-capable local-first editor but nonzero for webview shells; the reviewer story (fully usable with no account, demo graph) ships with submission.
6. **Clone size on mobile networks** (Git path) — accepted with progress UI; shallow/partial clone is the follow-up lever. The iCloud path sidesteps this: content downloads on demand.
7. **Webview memory on huge graphs / very large notes** — editing is the new pressure point; the step-11 memory pass is the checkpoint, with note-size guardrails as the lever. The iCloud path adds a cousin: the graph is fully downloaded by policy (the index needs the bytes), so "the graph must fit on the phone" is an assumption, not a guarantee.

---

## 10. UX Model

Keyboard-native is desktop identity; mobile translates it rather than imports it:

- **Touch-native, capture-first.** Thumb-reachable core actions; search as a visible surface, not a chord; the keyboard never occludes the caret. Full shortcut surfaces (⌘K palette) are explicitly out of v1 — hardware-keyboard iPad users fall back to visible affordances for now.
- **Minimal UI applies double.** Six screens, a tab/stack shell, a sync-status pill. No settings sprawl: storage, switch graph, GitHub connect/disconnect, and version.
- **Same visual language.** Design-system tokens, safe-area-aware layout (`viewport-fit=cover`), 16px minimum input font (blocks iOS auto-zoom), dark mode. iPad ships as "a big phone" in v1; a desktop-class iPad layout is an explicit later decision.
- **Plain-language sync.** "Backed up / Syncing / Needs review" — never commits, branches, or merges. Conflict language points users to open the note and choose what to keep.

---

## 11. Definition of Success (First Mobile Release)

Plan 19's acceptance criteria are the binding list. The product-level summary: a user succeeds if they can

1. Install the iOS app and, in minutes, open the graph already in their iCloud Drive — or start fresh there, keep notes on-device, or connect a GitHub graph.
2. See today's daily note instantly, offline or online.
3. Edit any note — including inserting a `[[wiki link]]` via autocomplete — with no markdown corruption, and find the edit in search and backlinks without restarting.
4. Lock the phone mid-thought and lose nothing, even if iOS kills the app.
5. See the edit on their Mac after the next sync — and when the rare conflict happens, choose what to keep on the phone while everything else keeps syncing.
6. Open the Files app and see their notes as portable markdown.

And the codebase succeeds if audio memos, share-sheet capture, and the AI copilot can be added in later waves **without** re-architecting the workspace, sync, privacy enforcement, or navigation.

---

## 12. Open Questions

Beyond Plan 19's settled scope, these remain genuinely open:

1. **App Group + capture-inbox schema** for the audio/share waves: file layout, ingest semantics, `private: true` handling at the inbox boundary, and when to provision the App Group + extension targets in the Xcode template (cheap early, annoying to retrofit — but not needed for v1).
2. **Semantic search graduation** (inherited from the indexing strategy): what battery/storage/latency evidence gates local embeddings on iOS, and does sqlite-vec/fastembed ever run there or does mobile stay lexical until a different runtime appears?
3. **AI-assisted conflict resolution**: Plan 21 defers it by design — the ladder hands AI the same base/local/remote triple it uses itself. When it arrives, how does mobile apply resolutions that require BYOK calls (the sync strategy's open question)?
4. **iPad posture**: how long does "big phone" hold before a two-pane layout is worth building?
5. **Deep links and the command registry**: when external automation (shortcuts, widgets) arrives, does `reflect://` map onto the same typed command layer as desktop?
6. **Graph-at-scale on iCloud**: full-download-by-policy plus O(all-notes) watch diffing and pending-walks are fine at today's graph sizes; what size forces delta-based intake or selective download?

Two of the original questions closed since the first draft: the daily-note append/append merge driver shipped as Plan 21's append-union rung, and the formatting toolbar shipped webview-drawn (Plan 19 decision 8).

---

## 13. Bottom Line for the Mobile Agent

Reflect V2 mobile is best understood as:

> The same local-first markdown app, recompiled for the pocket: today's note on open, real editing under a keyboard that finally behaves, instant offline search, and sync that hides behind three plain words — iCloud moving the files by default, Git for the self-managed — with voice, share-sheet, and AI capture waves arriving behind it on the same foundations.

Build it from the constraints that make V2 distinct: one codebase, markdown files the user can see in the Files app, a rebuildable per-device index, deterministic on-device conflict resolution, no servers, no accounts, `private: true` as a hard line when AI arrives — and V1 mobile's hardest-won lessons applied: gate the editor on a real device before building screens, keep canonical state below the webview, and make "lock the phone mid-thought" always safe.

Plan 19 is the route; this brief is the map of why.
