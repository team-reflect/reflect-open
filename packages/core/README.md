# @reflect/core

Reflect's TypeScript business logic and the interfaces of the platform
primitives it runs on. Nothing in this package imports React, TanStack,
`@tauri-apps/*` or `@reflect/app`: the native shell is reached through injected
adapters, so the same code runs in the desktop app, in plain vitest, and in any
other client. The app layer (windows, routes, commands, menus, update, theme,
boot flows) is [`@reflect/app`](../app/README.md).

## Services and the composition root

Everything stateful is a **service**: an interface `XxxService` and a factory
`createXxxService(deps)` in `<domain>/<name>-service.ts`. A service receives the
services it calls through `deps`. The package has no process-wide instances and
no module-level mutable state.

- **`createCoreServices(adapters)`** (`create-core-services.ts`) builds
  every service once and returns **`CoreServices`**. The host calls it once per
  webview, before `createAppServices`. `CoreInternalServices` holds the services
  that only other services use.
- **`CoreAdapters`** is what the host supplies: the IPC bridge, the platform
  facts, HTTP, Web storage, path, and the optional logger, clock, id,
  image codec and deep-link source. The desktop builds them in
  `apps/desktop/src/services/create-desktop-services.ts`
  (`createDesktopAdapters`).
- **Ports** are the `CoreAdapters` fields that the app layer implements:
  `progress` (`ProgressPort`), `activity` (`ActivityPort`), both in
  `ports/activity-port.ts` and `ports/progress-port.ts`, plus `role` (`'main'` or `'note-window'`),
  `peerIndexWrites` and `createGraphServices`. Core never asks which window it
  is in any other way.
- **Per-session services.** `createGraphServices(session, deps, flags)`
  (`create-graph-services.ts`) builds the services of one open graph and
  disposes them when `session.signal` aborts. The `GraphLifecycleFlags` pick
  which lifecycles run; the app layer decides them.
- **Events.** A service reports changes through `onXxx(listener)` /
  `subscribe(listener)`. This package never touches a UI cache.
- **`@reflect/core/testing`** (`testing/`) holds the test doubles and
  `createTestCoreServices(overrides)`, the whole container built by the
  production root over test adapters.

The conventions are in
[architecture-conventions](../../docs/plans/architecture-conventions.md) §3. To
add a service, follow [services.md](../../docs/contributing/services.md).

## The transport

`IpcBridgeService` (`createIpcBridgeService({ transport, logger })`) wraps the
host's `IpcBridge` transport (`invoke` + `listen`). It is the single point where
an untyped IPC response becomes a typed value: every response is zod-validated,
and every rejection becomes the shared `AppError`. The desktop builds one and
shares it with the app layer. Code never calls the transport directly.

## Domains

| Module | What it owns |
|---|---|
| `ports/` | The host ports (`ActivityPort`, `ProgressPort`) and the primitives with their default implementations: `LoggerService`, `ClockService`, `IdService`, `PlatformFacts`, `StorageService`, `HttpService`, `PathService`, `AppInfoService`. |
| `graph/` | Graph file storage: path helpers, the typed file services (`NoteFileService`, `AssetStoreService`), note creation and link resolution, the capture inbox, and the open graph (`GraphSessionService`). |
| `documents/` | Open notes: `NoteSessionService`, `OpenDocumentsService`, `NoteDocumentService`, moves and title renames, `NoteActionsService`, attachments and templates. |
| `markdown/` | The document model: frontmatter, the Lezer grammar with `[[wiki link]]`, extraction (`parseNote`), source-level edits. |
| `indexing/` | The SQLite projection: `IndexLifecycleService`, `IndexStoreService`, `FileChangeService`, and the read services over `DatabaseService` (`IndexQueryService`, `SearchService`, `BacklinkService`, ...). |
| `daily/` | `DailyNoteService`: today, which days have a daily note, the wake onto a new day. |
| `tasks/` | `TaskService` and the pure Tasks-view model. |
| `search/` | The updated-at filter presets of note search. |
| `navigation/` | The `reflect://` protocol: parsing, formatting, and `DeepLinkIntakeService` (intake and resolution to a `DeepLinkTarget`). Routes live in `@reflect/app`. |
| `ai/` | BYOK providers, the one-shot tasks (selection transform, describers, transcription), and `ai/chat/`. |
| `privacy/` | The `private: true` gate: `PrivacyService` and the `CloudSafe<T>` brand. |
| `capture/`, `assets/`, `audio/` | The background pipelines of an open graph: link capture, asset descriptions, audio memos. |
| `embeddings/` | Local semantic search: `EmbeddingIndexService`, `RetrievalService`, `SemanticSearchService`. |
| `sync/` | Git backup (`BackupService`, the sync engine, the GitHub services) and iCloud (`ICloudSyncService`, `ICloudDownloadService`). |
| `calendar/` | `CalendarService` (live EventKit reads) and the display policy of the events panel. |
| `contacts/` | `ContactsService`, `PersonNoteService`, `MeetingService`, `ContactSuggestionService`, and the matching rules. |
| `settings/` | The settings schema and `SettingsService`. |
| `monetization/` | The mobile subscription, paywall and App Store environment services (`CoreServices.mobile`). |
| `ipc/` | `IpcBridgeService` and the typed plugin bindings. |
| `testing/` | The `@reflect/core/testing` entry. Never imported by production code. |
| `errors.ts` | The `AppError` discriminated union shared with Rust. |

## Generations

Rust pins every write to a session with two counters: the file `generation`
(from `graph_open`) and the `indexGeneration` (from `index_open`). It rejects a
file write, and drops an index write, that carries a stale one, so a pass that
outlives a graph switch cannot land in the next graph. Rust-boundary wrappers
(`NoteFileService`) take the generation as a parameter. User-facing services
(`NoteActionsService`) read the open `GraphSession` once at method entry. Never
cache a generation across a graph switch.

## Indexing

`IndexLifecycleService` (`CoreServices.indexLifecycle`) owns every index pass.
`sync(session)` is the graph-open path: it re-indexes changed files, or
rebuilds when the projection version is stale, and then starts the live
subscription and the Rust file watcher. The live subscription is the only
incremental path: our own saves flow file, watcher, index, like any external
edit.

## Conventions

- zod-validate everything that crosses an external boundary (IPC responses,
  file contents, watcher events). Do not re-validate rows from our own SQLite
  projection.
- TypeScript surfaces are camelCase. Rust serializes camelCase through serde.
- Tests live next to the module they cover.
