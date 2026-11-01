# Reflect V1 Mobile Overview

A handoff for building the V2 mobile experience: what the V1 iOS app does, how it shares code with the V1 web app, and which architectural choices shaped it. The [V1 Overview](./reflect-v1-overview.md) covers the shared product model; this document covers what differs on mobile.

Source code: the `reflect-mobile` repository (separate from the main V1 `reflect` repo). Per-feature porting docs live in [docs/porting/reflect-mobile/](./porting/reflect-mobile/README.md).

## Product Summary

V1 Mobile is a capture-first companion, not a port of desktop: an iOS app (iPhone-first, iPad-capable) built with Capacitor 6 around a Next.js 14 + Ionic React web app, sharing the V1 domain model and sync stack.

The bet: mobile is where life happens, desktop is where organization happens. The app optimizes:

1. **Frictionless capture**: daily note by default; voice memos from the lock screen, Siri, widgets, and quick actions; a share extension for links.
2. **Trustworthy recording**: native audio capture and upload that survive webview crashes, calls, route changes, and network loss.
3. **Fast recall on the go**: a full local SQLite projection with full-text search, so reading and searching work offline.

Mobile deliberately leaves templates, connections, imports, the graph map, and note history to desktop/web.

## Relationship to the V1 Web Codebase

Shared code is **rsynced from a sibling checkout** of `reflect`, not consumed as a package: `sync.sh` copies the directories in `sync-include.txt` and skips web/desktop-only files listed in `sync-ignore.txt` (OPFS, web SQLite, embeddings/vector search, web keychain, and similar). Synced code (actions, most models, helpers, lib, and the api/asset/auth/db/firebase/search services) is read-only in the mobile repo. Mobile owns the app shell, screens, UI components, `capacitor/` bridges, `ios/`, and build/CI. Where web has platform variants, mobile provides a same-path file (e.g. `services/db/sqlite/kysely-setup.ts`) or a stub (vector search returns nothing). `currentPlatform()` is hardcoded to `Platform.Mobile`.

This kept domain logic identical across platforms, but it is manual, drift-prone, and makes synced files second-class. A V2 monorepo with shared packages removes the problem.

## How to Think About the Mobile App

Three layers with different reliability guarantees:

1. **The webview app** (Next.js + Ionic React + MobX): all UI, the editor, local SQLite, and sync. Assumed restartable at any time.
2. **The TypeScript bridge** (`capacitor/`): seven small plugin interfaces that define the webview↔native contract.
3. **The native Swift layer** (`ios/App/`): plugins plus app extensions. Anything that must not fail when the webview is dead lives here: recording and upload, share-extension capture, auth token storage, asset caching.

The defining decision: **critical capture paths do not depend on JavaScript being alive**. Recording uploads straight from Swift; the share extension calls the Reflect API with natively stored OAuth tokens; pending uploads persist in App Group defaults across restarts. The webview is treated as crashy (the repo ships crash detection for it), and the native layer is the reliability floor.

## Main App Surfaces

An Ionic tab bar with three tabs plus modals, routed by Ionic React Router (react-router v5), e.g. `/:graph/daily/:id`, `/:graph/tasks`.

- **Daily (default tab)**: a horizontal Swiper carousel of days (about ±50 days, re-centered near the edges) with a synced calendar strip. Mounted once to preserve swiper state. Waking from background on a new date re-navigates to today.
- **All Notes**: a virtualized list with a search bar and filter badges (tags, dates, pinned, public). Local FTS with desktop's ranking (BM25 with subject boost, recency boost, exact-subject pinning). Tag taps land here.
- **Search Chat (AI)**: an AI chat over the current search results, the same "chat over an explicit retrieval set" model as desktop, as its own page.
- **Tasks**: today / overdue / upcoming groups with drag-and-drop between groups (haptics), a quick-edit modal, and a scheduling picker.
- **Profile / Settings (modal)**: account, graph switcher, counts, a small settings subset (font size, week start, date/time format), JSON export to the share sheet, recovery and encryption keys, sign out, account deletion. Full preferences stay on desktop/web.
- **Note actions**: pin, share markdown, publish/unpublish, trash. The desktop context sidebar reduced to actions: no suggested backlinks, similar notes, or contacts.

Absent vs. desktop: graph map, note history, imports, command palette, semantic search, split panes, template management, calendar context on dailies, connections management. Mobile exposes a smaller surface over the same graph.

## The Editor on Mobile

The same `@team-reflect/reflect-editor` (ProseMirror + Yjs) runs in `mobile` mode: no inline toolbar or merge menu, and backlinks/tags open on tap.

The signature piece is the **native keyboard accessory toolbar**: a Swift plugin renders it above the iOS keyboard while the webview drives its items (slash commands, AI prediction, bullet, todo, backlink, tag, indent/outdent, move, image). A view model enables indent/move by selection, and the toolbar hides when a hardware keyboard (`GCKeyboard`) is attached.

AI in the editor matches desktop. Editor focus is managed outside the editor (`requestedFocusForNoteId`) so navigation can blur, route, and restore focus on the destination. `y-prosemirror` is patched for a null-selection crash: expect mobile webview selection to be a recurring source of editor bugs.

## Capture: Audio Recording

The most engineered feature and the clearest expression of the native-reliability philosophy. Entry points: in-app button, lock-screen widget, Live Activity / Dynamic Island, Siri App Intents, a quick action, and a `reflect-widget://` deep link.

The native flow (`RecordingPlugin.swift`):

1. `AVAudioRecorder` captures AAC mono at 44.1kHz; a Live Activity shows the timer with a stop button.
2. Interruptions (calls, Siri, alarms) and route changes stop the recording cleanly instead of corrupting it.
3. On stop, Swift uploads directly to Firebase Storage with metadata, using native auth tokens. No webview involved.
4. Failures persist in App Group defaults and retry with backoff, on network return, and with background-task time.
5. The V1 backend transcribes, and the transcript syncs into the daily note through normal note sync.

The webview side (a modal with a live waveform) is presentation only; transcription preferences are pushed into the native plugin.

## Capture: Share Extension, Widgets, Intents

- **Share extension** (SwiftUI): accepts URLs, pages, and text, and POSTs to `/api/graphs/{graphId}/links/async` with OAuth tokens shared through the `group.ReflectData` App Group. The V1 operations pipeline enriches the link. Errors queue in App Group defaults and reach Sentry on next foreground.
- **Lock-screen widget**, **Siri intents** (start/stop recording), and **quick actions** (Create Note, Record Audio).
- **Native action handshake**: these entry points can fire before the webview is ready, so a `NativeActions` plugin queues the action natively. The webview calls `finishSetup()` when mounted, then `confirmPerformed()`. The two stages prevent lost or double-fired actions across restarts.
- **Universal / dynamic links** for email-link auth and web→app handoff. **Push notifications** are wired but minor.

## Authentication and Secrets

- Sign in with Apple, Google (native sheets), or email (OTP or magic link via Firebase Dynamic Links).
- An **auth-sync bridge** sends the Firebase ID token to Swift, which exchanges it for Reflect OAuth tokens and stores them in App Group defaults. This is what lets the share extension, uploads, and widgets authenticate without the webview.
- Graph encryption passwords live in the iOS Keychain, per graph. OAuth client config lives in a git-ignored `ReflectConfig.plist` generated by fastlane.

Boot gates mirror desktop: Auth → SQLite migrating → graph setup → graph loading → encryption unlock → version check → initial sync → main tabs.

## Data, Sync, and Offline

The full V1 local-first stack with a Capacitor bottom layer:

- **SQLite** via `@capacitor-community/sqlite` with a Kysely dialect and the web's schema and migrations. All DB access is serialized (`pLimit(1)`) because the Capacitor bridge cannot handle concurrent access.
- **Tables** match the web projection; a `notesVec` table exists but is unused.
- **Search** is FTS5 only (BM25 with 3× subject weighting, recency/pinned/exact-match re-ranking). No on-device embeddings or semantic search, and desktop's trigram extension is disabled.
- **Sync** is the shared table-sync: Firestore→SQLite with per-table watermarks, SQLite→Firestore with change flags, debounced flushes, and flush-on-reconnect. Note content syncs as Yjs commits. Deletes stay soft locally until the remote delete succeeds.
- **Job queue** (`jobs` table): reindex, rewrite backlinks, repair docs; persisted so work survives restarts.
- **Offline**: reading, searching, editing, and creating all work offline. Sync pauses when the device is nearly full.

**Assets** are encrypted client-side and cached natively as encrypted blobs. A `reserveUpload → addUpload → getUpload` bridge protocol resolves races between concurrent uploads and downloads. A `reflect-assets://` scheme handler decrypts AES-GCM natively, so images work offline and load fast.

## Native Resilience Machinery

Where V1 mobile actually hurt:

- **WebView crash detection**: WKWebView terminations go to Sentry with an "activated recently" flag to separate startup crashes from background kills.
- **Beta workaround plugin**: iOS 17.2 betas broke Firebase persistence; a plugin detected OS beta upgrades, backed up local data, and warned the user. Lesson: iOS webview storage is not stable ground. Keep canonical state in SQLite/native files, not IndexedDB.
- **State recovery**: pending uploads, native actions, and extension errors persist in App Group defaults because the webview and even the process are assumed mortal.

## Build, Release, and CI

- **Dev loop**: `nr dev` serves Next.js on port 3001; `capacitor.config.ts` points the device at the machine's LAN IP.
- **Builds**: `nr dist` exports static Next.js, runs `cap sync`, and generates `ReflectConfig.plist`. Env vars come from Vercel.
- **Release**: fastlane handles config, build numbers (UTC timestamps, `YYYYMMDDHHmm`), certificates (fastlane match), TestFlight upload, and post-promotion version bumps.
- **CI**: lint + 4-shard vitest with the Firebase emulator on every push; pushes to `next` or `testflight-*` upload a TestFlight build.
- **Crash reporting**: Sentry natively and in the webview, with shared user context.

## Code Map for V2 Readers

Starting points in `reflect-mobile`: `client/core/` (shell, loading gates, tab routes), `client/models/ui/mobile-view.ts` (central mobile UI state), `client/screens/` (daily swiper, notes list, tasks, profile), `capacitor/` (the full webview↔native contract), `ios/App/App/Capacitor Plugins/` (Swift plugins), `ios/App/ShareExtension/`, `ios/App/App Widget/`, `ios/App/fastlane/Fastfile`, and `sync.sh` (the code-sharing mechanism).

## V2 Design Notes

Worth preserving:

- **Capture-first scope.** Mobile as a companion (daily note, voice, share, tasks, search), not a full port. Users did not miss the map or preferences on their phone.
- **Native reliability floor.** Voice capture and share-ins should not depend on the app's main runtime being healthy.
- **OS-level capture entry points.** Widget, Live Activity, Siri, quick actions, and the share extension are a large part of mobile's value. They need native targets and shared auth state regardless of framework.
- **Keyboard accessory toolbar.** The most important mobile editor affordance; selection-aware enable/disable matters.
- **Open-to-today + swipeable days** with a synced calendar strip.
- **Full local projection.** The whole graph in SQLite with FTS made the app fast and genuinely offline.
- **The native-action handshake** removes a whole class of cold-start races.

V2 changes or must decide:

- **Shell**: V2 targets Tauri 2 iOS with one frontend and Rust core in a monorepo. That removes the rsync scheme, the Capacitor plugin layer, and the serial-DB-lock constraint, but every native capability above (share extension, widgets, Live Activities, intents, background audio, App Groups, keychain) must be rebuilt as native iOS targets. Capacitor gave V1 most of these as plugins.
- **No Reflect-hosted APIs.** V1's most reliable paths POST to Reflect's servers. V2's principles remove that. The share extension and voice capture need a new design: write to shared local storage (App Group container), let the app ingest into markdown, and sync via Git/iCloud. This is the hardest open problem here: "capture when the app isn't running" was previously solved by the server.
- **Transcription**: V1 transcribed server-side. V2 must choose on-device (Apple Speech / local models) or BYOK, and honor `private: true` as a hard block at the capture layer.
- **Sync without Firestore.** Git/iCloud sync has different latency and conflicts. The daily note edited on phone and desktop the same day is the canonical conflict.
- **Semantic search parity.** V1 shipped mobile without vector search and nobody seems to have missed it badly: a data point for on-device embeddings in V2.
- **iPad**: V1 ships a phone UI on iPad. Decide early whether V2 treats iPad as desktop-class or a big phone.
- **WebView fragility is real.** Keep canonical state out of webview storage, and watch editor selection behavior.

Questions to answer before building:

- How does the share extension write a link into a markdown graph when the app isn't running, and how does that interact with Git/iCloud sync?
- Where does audio capture live (a native target writing to an App Group container?), and when does transcription happen under BYOK?
- Which capture entry points ship first, and which can wait?
- Does mobile use desktop's `.reflect/index.sqlite` schema (one schema, two writers?) or a separate projection?
- What is the offline conflict story for the daily note edited on two devices?
- Does mobile get the full editor or a constrained capture editor at first?

## One-Sentence Product Brief

Reflect V1 Mobile is a capture-first iOS companion to the Reflect graph (open-to-today daily notes, native-grade voice memos, share-sheet link capture, tasks, and offline full-text search), built as a Capacitor shell around the shared V1 web codebase with a native Swift reliability layer for everything that must not fail.
