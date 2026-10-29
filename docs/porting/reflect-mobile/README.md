# Porting Reflect V1 Mobile features to Reflect v2 mobile

This directory documents the user-facing behavior of Reflect V1 Mobile (the
Capacitor 6 + Ionic React iOS app in the separate `reflect-mobile` repo) so
it can be ported to the v2 mobile app (the Tauri 2 iOS target of this repo,
Plan 19). Each doc says what V1 mobile does in enough detail to rebuild it,
what changes in v2 and why, and how it maps onto v2's architecture.

It is the mobile analog of the desktop set in [`docs/porting/`](../README.md)
and the detailed companion to the
[V1 Mobile Overview](../../reflect-v1-mobile-overview.md). These win over
anything in this directory:

- [Plan 19 (mobile companion)](../../plans/19-mobile.md): scope, steps,
  acceptance criteria; the 2026-06-12 product call is **re-implement V1
  mobile's feature-set and design**.
- [V2 Mobile Grounding Brief](../../reflect-v2-mobile-grounding-brief.md):
  product brief and the V1→V2 surface mapping.
- [TDR 0003 (mobile shell)](../../decisions/0003-mobile-shell.md): Tauri 2
  mobile chosen; Capacitor is the documented fallback.
- [Product Vision](../../reflect-v2-product-vision.md) ·
  [Sync Strategy](../../reflect-v2-sync-strategy.md) ·
  [Indexing Strategy](../../reflect-v2-indexing-strategy.md).

## Why features can't be ported directly

v2 removes the three pillars V1 mobile is built on:

- **No servers, no accounts.** Every reliable V1 capture path (share
  extension, audio upload, push, OAuth token exchange) POSTed to Reflect's
  API or Firebase with natively-stored tokens. In v2 the phone is a peer
  device holding real markdown files, and mobile v1 network egress is
  GitHub sync only.
- **No E2EE, no encrypted database.** V1 decrypts an encrypted
  Firestore/SQLite graph behind an unlock gate. v2 notes are plain markdown
  in the app's `Documents/` (visible in Files); SQLite under `.reflect/` is
  a rebuildable per-device projection.
- **No Capacitor.** V1's seven custom plugins and its rsync code-sharing
  with the web repo dissolve. Native capabilities (keyboard, haptics,
  camera, share, secure storage) become first-party Tauri plugins or web
  APIs; app extensions (share, widgets, intents) become native iOS targets
  beside the Tauri shell.

What survives is the **product behavior**: open to today with swipeable
days, a keyboard that behaves, instant offline search, capture that is
never lost.

## The docs

| Doc                                                                   | V1 mobile feature                         | v2 status (per Plan 19)                          |
| --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| [App shell and navigation](./app-shell-and-navigation.md)             | Tab bar, routing, boot gates, FAB          | **v1** — Daily/All shell shipped-in-progress      |
| [Daily notes](./daily-notes.md)                                       | Day carousel + calendar strip              | **v1** — Embla carousel, V1 design parity         |
| [Editor and keyboard](./editor-and-keyboard.md)                       | Mobile editor + native accessory toolbar   | **v1** editing; toolbar deliberately re-designed  |
| [Search and All Notes](./search-and-all-notes.md)                     | FTS search, filters, list, AI search chat  | **v1** list+search; filters partial, chat later   |
| [Tasks](./tasks.md)                                                   | Task groups, drag-and-drop, quick edit     | **Shipped** — desktop Plan 18 data + touch surface |
| [Note actions, sharing, export](./note-actions-sharing-and-export.md) | Pin/share/publish/trash, JSON export       | **v1** pin/share/trash; publish deferred          |
| [Audio memos](./audio-memos.md)                                       | Native recording + server transcription    | **Implemented** — raw-first + BYOK transcription  |
| [Share extension](./share-extension.md)                               | Share-sheet link capture via API           | **Done** — App Group inbox → relay → shared drain |
| [Native entry points](./native-entry-points.md)                       | Widgets, Siri, quick actions, deep links   | **Shipped** with audio; push/universal links dropped |
| [Sync, offline, and data](./sync-offline-and-data.md)                 | Firestore↔SQLite sync, Yjs, job queue      | Replaced — behavior ports, architecture doesn't   |
| [Assets and images](./assets-and-images.md)                           | Encrypted asset cache + custom scheme      | Replaced — assets are plain files                 |
| [Auth, encryption, accounts](./auth-encryption-and-accounts.md)       | Sign-in, unlock, recovery kit, tokens      | **Dropped** — no accounts, no E2EE                |

## Conventions

- Unqualified paths like `client/screens/…`, `capacitor/…`, and
  `ios/App/…` are in the **`reflect-mobile` repo**; paths like
  `apps/desktop/src/mobile/…` and `packages/core/…` are in **this repo**
  (mobile is a build target of the one app; there is no `apps/mobile`).
- "Graph" is the user's workspace: in v2 a folder of markdown files with
  daily notes at `daily/YYYY-MM-DD.md`; in V1 mobile a set of encrypted
  documents with date IDs (`YYYY-MM-DD`).
- In `reflect-mobile`, `client/actions`, most of `client/models`,
  `helpers`, `lib`, `shared`, and `services` are **rsynced from the V1 web
  repo** (`sync.sh` + `sync-include.txt`). Mobile-owned code is
  `client/core/`, `client/screens/`, `client/models/ui/`,
  `client/models/capacitor/`, `components/`, `capacitor/` (plugin
  bridges), and `ios/` (Xcode project and Swift).
- V1 behavior was verified against `reflect-mobile` in 2026-07; it is a
  snapshot, not a living spec.
