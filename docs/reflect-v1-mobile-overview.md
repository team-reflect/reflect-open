# Reflect V1 Mobile Overview

This document is a handoff for an agent or engineer building the mobile experience for a second version of Reflect. It summarizes what the existing iOS app does, how it shares code with the V1 web app, and which architectural choices shaped the mobile implementation.

It is a companion to the [V1 Overview](./reflect-v1-overview.md), which covers the shared product model (graphs, notes, backlinks, tasks, sync). This document focuses on what is different on mobile.

Source code: the `reflect-mobile` repository (separate from the main V1 `reflect` repo).

Per-feature porting docs — what each V1 mobile feature did in detail and how it maps onto V2 — live in [docs/porting/reflect-mobile/](./porting/reflect-mobile/README.md).

## Product Summary

Reflect V1 Mobile is a capture-first companion app, not a port of the desktop experience. It is an iOS app (iPhone-first, iPad-capable) built with Capacitor 6 wrapping a Next.js 14 + Ionic React web app, sharing the V1 domain model and sync stack with the web codebase.

The product bet is that mobile is where life happens and desktop is where organization happens. The app optimizes three things:

1. **Frictionless capture**: daily note opens by default, voice memos are reachable from the lock screen, Siri, widgets, and home-screen quick actions, and a share extension saves links from any app.
2. **Trustworthy recording**: audio capture and upload run natively, surviving webview crashes, phone calls, route changes, and network loss.
3. **Fast recall on the go**: full local SQLite projection of the graph with full-text search, so reading and searching notes works offline.

What mobile deliberately does *not* try to be: the place where users manage templates, connections, imports, the graph map, or note history. Those stay on desktop/web.

## Relationship to the V1 Web Codebase

The mobile repo does not depend on the web repo as a package. Instead, shared code is **rsynced from a sibling checkout** of the main `reflect` repo:

- `sync.sh` copies directories listed in `sync-include.txt` from `../reflect` into the mobile repo.
- `sync-ignore.txt` excludes web/desktop-only files (`*.desktop.ts`, import helpers, service-worker hooks, OPFS, web SQLite setup, embedding/vector search, asset text extraction, web keychain).

What is synced (shared, treat as read-only in the mobile repo):

- `client/actions`, `client/errors`, and most `client/models/*` (note, graph, task, backlink, change, search, user, preferences, etc.).
- `helpers`, `lib`, `shared`, `testing`.
- `services/api`, `services/asset`, `services/auth`, `services/db`, `services/firebase`, `services/search`, `services/logger`, `services/export/export-json.ts`.

What is mobile-owned:

- `client/core/` (app shell, router), `client/screens/`, `client/models/ui/`, `client/models/capacitor/`.
- `components/` (all UI components).
- `capacitor/` (TypeScript plugin bridges) and `ios/` (the Xcode project and Swift code).
- `pages/` (a thin Next.js shell), build scripts, fastlane, CI.

Where the web repo has platform variants, mobile either provides its own file with the same path (e.g. `services/db/sqlite/kysely-setup.ts`, `lib/platform-keychain.ts`) or stubs the capability (e.g. vector search returns no results).

This code-sharing model kept the domain logic identical across platforms, but it is manual, drift-prone, and makes the synced files second-class citizens in the mobile repo. A V2 monorepo with shared packages removes this entire class of problem.

`services/platform.ts` is hardcoded on mobile: `currentPlatform()` always returns `Platform.Mobile` and the agent is `iphone`. Shared code branches on this to disable web-only behavior.

## How to Think About the Mobile App

The app is three layers with different reliability guarantees:

1. **The webview app** (Next.js + Ionic React + MobX): all product UI, the editor, local SQLite, and sync. Assumed to be restartable at any time.
2. **The TypeScript bridge** (`capacitor/`): seven small plugin interfaces (alert, assets, auth-sync, image-preview, keyboard-toolbar, native-actions, recording) that define the webview↔native contract.
3. **The native Swift layer** (`ios/App/`): custom Capacitor plugins plus app extensions. Anything that must not fail when the webview is dead lives here — audio recording and upload, share-extension link capture, auth token storage, asset caching.

The defining V1 mobile design decision is that **critical capture paths do not depend on JavaScript being alive**. Recording uploads straight from Swift to storage; the share extension calls the Reflect API directly with natively-stored OAuth tokens; pending uploads persist in App Group defaults across app restarts. The webview is treated as crashy (it is — the repo ships webview-crash detection and Sentry context for it), and the native layer is the reliability floor.

## Main App Surfaces

Navigation is an Ionic tab bar with three tabs, plus modals. Routing is Ionic React Router (react-router v5) with routes like `/:graph/journal/:id`, `/:graph/all/:id`, `/:graph/all/tag/:tag`, `/:graph/tasks`, and `/:graph/all/ai-chat`.

### Daily (default tab)

The daily-notes surface is a horizontal Swiper carousel of date slides (roughly ±50 days around the selected date, re-centered as the user swipes near the edges), with a swipeable calendar strip at the top that stays in sync with the main carousel. The component mounts once and is reused across navigation to preserve swiper state.

The app re-navigates to today when it wakes from background and the date has changed — open the app, see today.

### All Notes

A virtualized list (react-virtuoso) of notes with an `IonSearchbar`, filter badges (tags, dates, pinned, public), and tap-to-open. Search is local FTS with the same ranking logic as desktop (BM25 with subject boosting, recency boost, exact-subject pinning). Tag taps from the editor land here as filtered lists.

### Search Chat (AI)

From the search bar, the user can start an AI chat grounded in the current search results — the same "chat over an explicit retrieval set" model as desktop, presented as its own page (`/:graph/all/ai-chat`) rather than a modal toggle. The chat view model is shared with the notes-list code.

### Tasks

A grouped task list (today / overdue / upcoming, mirroring desktop's groupings) with mobile-native interactions: drag-and-drop between groups via dnd-kit with haptic feedback, a quick-edit modal for editing a task without opening its note, and a scheduling picker.

### Profile / Settings (modal)

A card modal, not a screen: avatar and email, graph switcher, note/recording counts, a small settings subset (font size, week start, date/time format), JSON export (written to the cache directory and handed to the iOS share sheet), recovery-key creation, encryption key access, sign out, and account deletion. Full preferences (templates, connections, AI providers, billing) remain on desktop/web.

### Note actions

Each note has an options popover: pin/unpin, share (native share sheet with the note's markdown), publish/copy public URL/unpublish, move to trash. This is the mobile equivalent of the desktop context sidebar, reduced to actions only — there is no suggested-backlinks/similar-notes/contacts intelligence on mobile.

### What is absent vs. desktop

No graph map, no note history UI, no imports, no command palette (search is a tab, not `Cmd+K`), no semantic search, no split panes, no template/prompt-template management, no calendar/meeting context on daily notes, no connections management. The mobile app reads and writes the same graph; it just exposes a smaller surface over it.

## The Editor on Mobile

The same `@team-reflect/reflect-editor` (ProseMirror + Yjs) is embedded with mobile-specific configuration: `mobile` mode on, inline toolbar off, merge menu off, backlinks and tags open on tap instead of becoming selectable.

The signature mobile piece is the **native keyboard accessory toolbar**:

- A Swift Capacitor plugin renders a toolbar above the iOS keyboard; the webview drives its items and enabled states.
- Items: slash commands, AI prediction toggle, bullet, todo, backlink, tag, indent/outdent, move up/down, and image insertion (via the Capacitor Camera plugin, base64 round-trip into the editor's upload pipeline).
- A MobX view model (`client/models/capacitor/keyboard-toolbar-view.ts`) observes editor selection and enables/disables indent/move buttons accordingly.
- The native side detects hardware keyboards (`GCKeyboard`) and hides the toolbar when one is attached.

AI in the editor matches desktop: prompt templates are passed into the editor (AI palette) and prediction is toggleable from the toolbar. Editor focus is managed outside the editor (a `requestedFocusForNoteId` flag on the mobile UI store) so navigation — e.g. tapping a backlink — can blur, route, and restore focus on the destination note.

`y-prosemirror` is patched via patch-package for a null-selection crash; expect mobile webview selection behavior to be a recurring source of editor bugs.

## Capture: Audio Recording

Audio is the most engineered feature in the app and the clearest expression of the native-reliability philosophy.

Entry points: in-app record button, lock-screen widget, Dynamic Island / Live Activity, Siri App Intents ("Start recording in Reflect" / stop), home-screen quick action, and a `reflect-widget://` deep link.

The native flow (`RecordingPlugin.swift`, ~600 lines):

1. `AVAudioRecorder` captures AAC mono at 44.1kHz; a Live Activity shows the elapsed timer with a stop button (Dynamic Island on iOS 17+).
2. Audio interruptions (calls, Siri, alarms) and input-route changes (headphones unplugged) stop the recording cleanly instead of corrupting it.
3. On stop, Swift uploads the file directly to Firebase Storage with metadata (`processAs: audioRecording-v2`, user/graph/note IDs, transcription language/format flags) using natively-stored auth tokens — no webview involved.
4. Failures persist in App Group defaults and retry with exponential backoff; `NWPathMonitor` retries when the network returns; a background task buys upload time after the app is backgrounded.
5. The V1 backend transcribes the file and the transcript syncs into the daily note through the normal note-sync pipeline.

The webview side (`capacitor/recording.ts` + a recording modal with a live waveform from native metering events) is presentation only. Transcription preferences (language, format, prompt hints) are pushed from the webview's preference store into the native plugin reactively.

## Capture: Share Extension, Widgets, Intents

- **Share extension** (separate target, SwiftUI): accepts URLs, web pages, and text from the iOS share sheet and POSTs to `/api/graphs/{graphId}/links/async` directly, using OAuth tokens shared through the `group.ReflectData` App Group. Link enrichment then happens through the V1 operations pipeline (the client later applies the resulting note). Errors are queued in App Group defaults and reported to Sentry when the main app next foregrounds.
- **Lock-screen widget**: a record button that deep-links via `reflect-widget://`.
- **Siri App Intents**: start/stop recording.
- **Quick actions** (home-screen long-press): Create Note and Record Audio.
- **Native action handshake**: because these entry points can fire before the webview is ready, a `NativeActions` plugin queues the requested action natively; the webview calls `finishSetup()` when its UI is mounted and then `confirmPerformed()` — a two-stage handshake that prevents lost or double-fired actions across app restarts.
- **Universal links / dynamic links**: associated domains for `m.reflect.app`, `l.reflect.app`, and Firebase Dynamic Links domains; used for email-link auth and web→app handoff.
- **Push notifications** are wired (`@capacitor/push-notifications`, APNs entitlement) but are a minor surface.

## Authentication and Secrets

- Sign in with Apple, Google (native sheets via `@capacitor-firebase/authentication`), or email (OTP code or magic link; magic links round-trip through Firebase Dynamic Links into `/auth/callback/email`).
- After Firebase auth resolves in the webview, an **auth-sync bridge** sends the Firebase ID token to Swift, which exchanges it for Reflect OAuth access/refresh tokens via `/api/oauth/token` and stores them in App Group defaults. This is what lets the share extension, recording uploads, and widgets authenticate without the webview.
- Graph encryption passwords are stored in the iOS Keychain (`capacitor-secure-storage-plugin`), keyed per graph.
- OAuth client credentials and the API endpoint live in `ReflectConfig.plist`, which is git-ignored and generated from env vars by a fastlane lane (`sync_config`).

The boot gate sequence mirrors desktop, expressed as a loading-state machine on the root store: Auth → SQLite migrating → graph setup → graph loading → encryption unlock → version check → initial sync (with progress UI) → main tabs.

## Data, Sync, and Offline

The mobile app runs the full V1 local-first stack, with a Capacitor-specific bottom layer:

- **SQLite** via `@capacitor-community/sqlite` with a `capacitor-sqlite-kysely` dialect, one database file, the same Kysely schema and migration pattern as the web. All DB access is serialized through a `pLimit(1)` lock because the Capacitor bridge cannot tolerate concurrent access.
- **Tables** match the web projection: `notes` (with Yjs update state + derived fields), `notesFts`, `noteBacklinks`, `assets`/`assetsFts`, `contacts`, `books`, `commitBackups`, `jobs`, `lastSyncs`, plus a `notesVec` table that exists in the schema but is unused.
- **Search** is FTS5 only (unicode61 tokenizer, BM25 with 3× subject weighting, recency/pinned/exact-match re-ranking). The vector search manager is a stub that returns empty results — there is no on-device embedding or semantic search in V1 mobile. The trigram extension used on desktop is also disabled on mobile.
- **Sync** is the shared table-sync abstraction: Firestore→SQLite down-sync with per-table watermarks (`lastSyncs`) and pagination; SQLite→Firestore up-sync with `hasChanges` flags, debounced flushes, and flush-on-reconnect. Note content syncs as Yjs commits through the shared change manager. Deletes are soft locally until the remote delete succeeds.
- **Job queue** (`jobs` table): reindex search, rewrite backlinks, repair outdated docs — persisted so background work survives app restarts.
- **Offline**: reading, searching, editing, and creating notes all work offline; changes queue locally. Network state comes from `@capacitor/network`. The app also monitors free disk space periodically and pauses sync when the device is nearly full.

### Assets

Encrypted asset handling has a native cache layer:

- Files are encrypted client-side (`@team-reflect/file-crypto` in a worker) and uploaded to the asset host; the encrypted blobs are also cached natively in `Library/Caches/AssetsCache`.
- A `reserveUpload → addUpload → getUpload` bridge protocol coordinates the webview's crypto pipeline with the native cache and resolves races between concurrent uploads and downloads.
- A custom `reflect-assets://` WKWebView scheme handler serves images: it fetches the encrypted blob (with retries), decrypts AES-GCM natively, and returns the asset to the webview — so images in notes work offline and load fast.
- Image capture comes from the Capacitor Camera plugin; full-screen image preview is a native viewer (Agrume).

## Native Resilience Machinery

Worth knowing because it reveals where V1 mobile actually hurt:

- **WebView crash detection**: the bridge view controller posts a notification when WKWebView terminates; the app tracks it in Sentry with an "activated recently" flag to separate startup crashes from background kills.
- **Beta workaround plugin**: iOS 17.2 betas broke Firebase persistence; a dedicated plugin detects OS beta upgrades, backs up local data, and warns the user. The lesson: webview storage on iOS is not stable ground — keep canonical local state in SQLite/native files, not IndexedDB.
- **Recording state recovery**: pending uploads, requested native actions, and extension errors all persist in App Group defaults precisely because the webview and even the app process are assumed mortal.

## Build, Release, and CI

- **Dev loop**: `nr dev` runs Next.js on port 3001; `capacitor.config.ts` auto-detects the machine's LAN IP and points the device/simulator at it. The app is also testable in a desktop browser in responsive mode.
- **Builds**: `nr dist` does a static Next.js export to `out/`, `cap sync`/`copy`, and syncs `ReflectConfig.plist` from env vars. Env vars come from Vercel (`vercel env pull`).
- **Release**: fastlane lanes handle config sync, build-number bumps (build numbers are UTC timestamps, `YYYYMMDDHHmm`), certificate management (fastlane match against a private encrypted certificates repo), TestFlight upload, and version bumps after App Store promotion.
- **CI** (GitHub Actions): lint + 4-shard vitest with the Firebase emulator on every push; every push to `next` or a `testflight-*` branch builds and uploads a TestFlight build on a macOS runner.
- **Crash reporting**: Sentry on both sides (`@sentry/capacitor` natively, `@sentry/nextjs` in the webview), with shared user context set from the auth-sync plugin.

## Code Map for V2 Readers

Mobile-owned starting points (paths in the `reflect-mobile` repo):

- `client/core/app.tsx`, `client/core/loader.tsx`: app shell and loading-state gates.
- `client/core/router-tabs.tsx`: tab structure and routes.
- `client/models/ui/mobile-view.ts`: central mobile UI state (app lifecycle, recording modal, focus requests, disk space).
- `client/models/ui/navigation-view.ts`: navigation + deep-link intents.
- `client/screens/note-edit/`: daily-note swiper and editor integration (`note-daily-edit-view.ts`, `note-edit-main.tsx`).
- `client/models/capacitor/keyboard-toolbar-view.ts` + `capacitor/keyboard-toolbar.ts`: keyboard accessory toolbar.
- `client/screens/notes-list/`: all-notes list, search, filters, AI chat.
- `client/screens/tasks/`: task groups, drag-and-drop, quick edit.
- `client/screens/profile/`: settings modal, export, recovery key.
- `capacitor/`: the full webview↔native contract in seven small files.
- `ios/App/App/Capacitor Plugins/`: Swift plugins (Recording, AuthSync, NativeActions, KeyboardToolbar, Assets, Alert, ImagePreview, BetaWorkaround).
- `ios/App/ShareExtension/`: share-sheet link capture.
- `ios/App/App Widget/`: lock-screen widget and recording Live Activity.
- `ios/App/fastlane/Fastfile` and `.github/workflows/`: release pipeline.
- `services/db/sqlite/kysely-setup.ts`, `services/db/sqlite/sqlite-db.ts`: mobile SQLite bottom layer.
- `sync.sh`, `sync-include.txt`, `sync-ignore.txt`: the code-sharing mechanism with the main repo.

## V2 Design Notes

Things V1 mobile got right and worth preserving:

- **Capture-first scope.** Mobile as a companion (daily note, voice, share, tasks, search) rather than a full port. Users did not lose anything important by not having the map or preferences on their phone.
- **Native reliability floor.** Recording and link capture work even when the web layer is dead. Whatever V2's shell is, voice capture and share-ins should not depend on the app's main runtime being healthy.
- **OS-level capture entry points.** Lock-screen widget, Live Activity, Siri intents, quick actions, and the share extension are a large part of mobile's value. These require native targets and shared auth state (App Groups in V1) regardless of framework.
- **Keyboard accessory toolbar.** The single most important mobile editor affordance; selection-aware enable/disable matters.
- **Open-to-today + swipeable days.** The daily carousel with a synced calendar strip is the right mental model for mobile daily notes.
- **Full local projection.** Having the whole graph in SQLite with FTS made the app feel fast and genuinely offline-capable.
- **The native-action handshake.** Queuing OS-triggered actions natively until the UI declares readiness eliminates a whole class of cold-start races.

Things V2 changes or must decide differently:

- **Shell**: V2 already targets Tauri 2 iOS instead of Capacitor, sharing one frontend and Rust core in a monorepo. That dissolves the rsync code-sharing scheme, the Capacitor plugin layer, and the serial-DB-lock constraint — but every native capability above (share extension, widgets, Live Activities, intents, background audio, App Groups, keychain) still has to be rebuilt as native iOS targets alongside the Tauri shell. Capacitor gave V1 most of these as plugins; V2 owns them directly.
- **No Reflect-hosted APIs.** V1 mobile's most reliable paths — native recording upload and share-extension capture — work by POSTing to Reflect's servers with OAuth tokens. V2's principles (markdown source of truth, no Reflect infrastructure, BYOK) remove that option. The share extension and voice capture need a new design: write to shared local storage (App Group container) and let the app ingest into markdown, with sync via Git/iCloud. This is the hardest open problem this document surfaces; "capture when the app isn't running" was previously solved by the server.
- **Transcription**: V1 transcribed server-side after upload. V2 must choose on-device transcription (Apple Speech / local models) or BYOK provider calls, and honor `private: true` as a hard block at the capture layer.
- **Sync without Firestore.** V1 mobile got real-time-ish sync and watermarked catch-up from Firestore listeners. Git/iCloud-based sync has different latency and conflict characteristics; the daily-note-on-two-devices case (phone + desktop, same day) becomes the canonical conflict to design for.
- **Semantic search parity.** V1 quietly shipped mobile without vector search and nobody seems to have missed it badly — useful data point when deciding whether on-device embeddings are worth it in V2.
- **iPad**: V1 supports iPad orientations but ships a phone UI. Decide early whether V2 treats iPad as a desktop-class layout or a big phone.
- **WebView fragility is real.** Crash detection, beta-OS workarounds, and patched selection bugs were all responses to WKWebView instability. Keep canonical state out of webview storage, and keep an eye on editor selection behavior in any embedded-webview editor.

Questions a V2 mobile agent should answer before building:

- How does the share extension write a link into a markdown graph when the main app process isn't running, and how does that interact with Git/iCloud sync?
- Where does audio capture live (native target writing to an App Group container?) and when/where does transcription happen under BYOK?
- Which capture entry points ship at v1: share extension, widget, intents, quick actions — and which can wait?
- Is the mobile SQLite index the same `.reflect/index.sqlite` schema as desktop (one schema, two writers?) or a separate projection?
- What is the offline conflict story for the daily note edited on two devices?
- Does mobile get the full editor or a constrained capture editor at first release?

## One-Sentence Product Brief

Reflect V1 Mobile is a capture-first iOS companion to the Reflect graph — open-to-today daily notes, native-grade voice memos, share-sheet link capture, tasks, and offline full-text search — built as a Capacitor shell around the shared V1 web codebase with a native Swift reliability layer for everything that must not fail.
