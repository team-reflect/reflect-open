# Architecture & Conventions

Cross-cutting conventions for the whole codebase, adapted from `~/repos/picardo` (a
separate first-party app with battle-tested structure).
These four decisions were made deliberately and apply to **every** plan; individual
phase plans reference this doc rather than restating it.

| Decision | Choice |
|---|---|
| Repo structure | **Turborepo monorepo, adopted now (lightweight)** |
| Business-logic home | **TypeScript `core`; Rust = native primitives** |
| Code organization | **Per-domain services, built once by a composition root** |
| Database access | **Full Kysely discipline** (`Selectable/Insertable/Updateable`, `json()`, camelCase) |

## 1. Monorepo layout (adopt now, lightweight)

Turborepo + pnpm workspaces, `@reflect/*` package names, `tsc -b` project references
(kept in sync with `monorepo-typescript-references`-style tooling). Start with the
minimum set of packages and add `apps/cli` / `apps/extension` when their phases land —
not as empty stubs up front.

```text
reflect-open/
├── apps/
│   ├── desktop/          # Tauri app — src/ (React) + src-tauri/ (Rust primitives)
│   ├── cli/              # Rust CLI (Plan 14) — self-contained `reflect` binary; added at Plan 14
│   └── extension/        # Chrome MV3 capture extension (Plan 11) — added at Plan 11
├── packages/
│   ├── core/             # ALL TS business logic: <domain>/<name>-service.ts, the markdown layer
│   ├── app/              # the app layer: windows, routes, commands, menus, update, boot flows
│   ├── db/               # Kysely schema/types + the IPC query-builder dialect
│   └── design-system/    # existing design tokens/components (already present)
├── docs/
└── turbo.json, pnpm-workspace.yaml, tsconfig (project refs)
```

**The load-bearing rule (from picardo):** *no business logic in the app shell.* In
Reflect that means **no file/DB/AI/sync logic in React components, hooks, or Tauri command
handlers.** Components and hooks call `@reflect/core` services (§3); Tauri `#[command]`
handlers are thin wrappers over native primitives. Picardo's "never write DB queries in a
tRPC router" becomes Reflect's "never write file/DB/AI logic in a component or a Rust
command handler: put it in a core service." No windows, routes, menus or pixels in
core: those belong to `@reflect/app`.

## 2. TS core, Rust = primitives

Reflect has no server. The boundary runs between **TypeScript business logic** and a
**thin Rust primitive surface**, bridged by the IPC layer (`IpcBridgeService`, §3).

| Lives in `@reflect/core` (TypeScript) | Lives in `@reflect/app` (TypeScript) | Lives in `apps/desktop/src-tauri` (Rust primitive) |
|---|---|---|
| Reads (Kysely queries over IPC) | Navigation history and `Route`; which route a deep link opens | SQLite open/migrate/query/exec; FTS5 + sqlite-vec extension loading |
| Orchestration of file writes + reindex | Windows, the app lifecycle, the quit and background policy | Atomic file IO, OS-trash delete, path-traversal guard, file watching |
| AI/provider calls, context assembly, patchsets | Commands, keymap, native menus, palette search | Local embedding runtime (model download + `embed`) |
| Privacy/capability guards (`private: true`) | The operations list, update, theme, exception telemetry | Git operations (libgit2), keychain get/set/delete |
| Sync conflict normalization + resolution policy | The graph boot flows (`GraphBootService`, mobile onboarding) | Native menus, global shortcuts, dialogs |
| The markdown parse/serialize layer (Plan 03) | (none) | — |

Rust owns *capabilities*; TypeScript owns *policy and composition*. A Rust command never
encodes product rules beyond the primitive it exposes (e.g. the watcher emits events; it
doesn't decide what to reindex: `IndexLifecycleService` in core does). One deliberate exception: the CLI
(Plan 14) is a self-contained Rust binary that re-implements the small read-side contract
rather than reusing `@reflect/core` — see Plan 14 for the rationale and parity-test
guardrails.

## 3. Services and the composition root

Business logic is organized by **domain** under `packages/core/src/<domain>/`
(`graph`, `documents`, `indexing`, `daily`, `tasks`, `search`, `embeddings`, `ai`,
`capture`, `audio`, `sync`, ...). The app layer uses the same layout under
`packages/app/src/<domain>/`. Each domain exposes **services**. There are no
process-wide instances and no module-level mutable state in either package: two
composition roots build every service once and pass each one what it needs.
[docs/contributing/services.md](../contributing/services.md) is the step-by-step guide.

### What a service is

- An interface `XxxService`, a deps interface `XxxServiceDeps`, an unexported class
  `XxxServiceImpl` and a factory `createXxxService(deps)` in one file:
  `packages/core/src/<domain>/<name>-service.ts`
  (`documents/note-move-service.ts`, `indexing/index-store-service.ts`).
- The factory returns `new XxxServiceImpl(deps)`. State lives in `#` fields of the
  class. Callers only see the interface.
- `deps` is one object, stored in the `readonly #deps` field. It holds the other
  services the service calls, each typed as the full service. A service never
  imports another service's instance.
- Pure rules (path helpers, markdown transforms, grouping, formatting) stay plain
  exported functions next to the service. They take no `deps`.
- The few pure functions that do need a service take it as a first parameter `ctx`
  (`ensureWelcomeNote(ctx, options)` in `graph/onboarding.ts`).

```ts
// packages/core/src/ports/app-info-service.ts
class AppInfoServiceImpl implements AppInfoService {
  readonly #deps: AppInfoServiceDeps

  constructor(deps: AppInfoServiceDeps) {
    this.#deps = deps
  }

  async version(): Promise<string> {
    return await this.#deps.ipc.call('app_version', {}, appVersionSchema)
  }
}

export function createAppInfoService(deps: AppInfoServiceDeps): AppInfoService {
  return new AppInfoServiceImpl(deps)
}
```

**zod scope.** Validate at genuinely *external* boundaries: file contents, provider
responses, IPC responses crossing from Rust (`IpcBridgeService.call` takes the schema).
Do **not** `zod.parse` every row of our own SQLite projection (it's our schema,
Rust-serialized); trust the Kysely types there.

**Errors.** Services throw the shared `AppError` class
(`packages/core/src/errors.ts`). Its `kind` is the same contract Rust
serializes; `IpcBridgeService` turns a Rust rejection into an instance.

**Privacy guards.** The `private: true` hard-block is a type, not a convention:
a `CloudSafe<T>` value (`privacy/cloud-safe.ts`) is minted only by the gate in
`privacy/privacy-service.ts` (`PrivacyService` and its pure `cloudSafe*` constructors),
and every provider-bound input requires one.

### Three packages and two roots

- `@reflect/core` (`packages/core`): business logic and the interfaces of the
  platform primitives. `createCoreServices(adapters)` in `create-core-services.ts`
  returns `CoreServices`. `CoreAdapters` is what the host supplies, because core never
  imports `@tauri-apps/*`: the IPC bridge, the platform facts, HTTP, Web storage, path,
  and the ports.
  Core keeps its roots in `src/`, its host ports in `src/ports/`, and the rest in domain
  directories. A file that exports a service is named after it.
- `@reflect/app` (`packages/app`): the app layer. `createAppServices(core, host)` in
  `src/create-app-services.ts` returns `AppServices` over the core services. `AppHost`
  is what the host supplies: the window, lifecycle and operations services, dialogs,
  clipboard, opener, updater and native menu host.
- `apps/desktop`: React and the adapters. Lint keeps React, TanStack and Tauri out of
  both packages, and `@reflect/app` out of core.

A **port** is an interface in `packages/core/src/ports/` that core calls and an
app service implements: `progress` (`ProgressPort`, the app's `OperationsService`) and
`activity` (`ActivityPort`, the app's `AppLifecycleService`). `role` (`'main'` or
`'note-window'`) tells core which window it runs in.

The desktop adapters live in `apps/desktop/src/services/`: `tauri-*.ts` wrap the Tauri
APIs, `browser-*.ts` are the plain-browser equivalents for `pnpm dev` without the shell,
and `create-desktop-services.ts` picks one set by `facts.isNativeShell`
(`createDesktopAdapters` for core, `createDesktopHost` for app).
`apps/desktop/src/boot.ts` builds, in order: the shared primitives (`logger`, `clock`,
`ipc`), the host, `coreServices`, and `appServices`. Only `main.tsx` and the platform
roots import them. In browser dev the transport is a deferred one (`deferred-ipc.ts`):
calls made before the in-memory dev backend connects wait for it.

The services only a mobile platform builds (`haptics`, `subscription`, `paywall`,
`mobileAudioMemo`, ...) are in `CoreServices.mobile`, which is `null` elsewhere.

### How code reaches a service

- **Core:** through `deps`. Nothing else.
- **React:** `main.tsx` renders `CoreServicesProvider` and `AppServicesProvider`
  (`apps/desktop/src/services/services-provider.tsx`). Components and hooks call
  `useCoreServices()` for core services and `useAppServices()` for app services, and
  destructure what they use:

  ```ts
  const { agentSkill } = useCoreServices()
  const { platform } = useAppServices()
  ```

  Both hooks throw outside their provider. Do not add per-service hooks. The
  mobile tree uses `useMobileAppServices()` (`mobile/mobile-services.ts`), which adds
  `app.mobile` and throws when it is `null`.
- **Non-React desktop modules** (`lib/`, `providers/*.ts`): the leading parameters
  are the services the function uses, or the `CoreServices` container (and a second
  `AppServices` one) when it uses three or more. The React caller passes the
  services it reads from `useCoreServices()`:

  ```ts
  // apps/desktop/src/lib/query-options.ts
  export function createTemplatesQueryOptions(
    indexQuery: IndexQueryService,
    root: string | undefined,
  )
  ```

- **Commands:** `CommandContext` (`apps/desktop/src/lib/commands/types.ts`) has
  `services: CoreServices` and `app: AppServices`. A command that calls a service reads it from the
  context it runs with, never from an import.

Providers are thin shells. `GraphProvider` reads its service with
`useServiceState` and passes its methods through (`useSync()` does the same for the
graph's backup); the state machine is in core.
`useSettings()` and `useTheme()` read their service directly, with no provider.
(`RouterProvider` uses `subscribe` + `useState`: a `useSyncExternalStore` update inside
a transition still commits the `Suspense` fallback of a lazy screen.)

### Per-session factories

Some work belongs to one graph session, not to the app: it starts when a graph (or an
index session) opens and must stop, with its timers and subscriptions, when that graph
closes. Building it once per app would let a pass or a pending turn of the previous
graph leak into the next one. For these, a **factory** (in the `graphServiceFactories`
table of `create-graph-services.ts`) or an app-scoped `openSession` method builds the
instance, and `createGraphServices` (`create-graph-services.ts`)
creates one instance per `GraphSession` and disposes it when `session.signal` aborts.
Its `GraphLifecycleFlags` pick the lifecycles; `createAppGraphServices`
(`packages/app/src/graph/graph-lifecycles.ts`) decides them from the window role:

| Created by | Creates | Lifetime |
|---|---|---|
| `graphServiceFactories.backup(deps, { generation, indexGeneration })` | `BackupService` | one per graph session, main window only (`GraphServices.backup`) |
| `graphServiceFactories.icloudSync(deps, ...)` | `ICloudSyncService` | one per iCloud graph session, main window only |
| `graphServiceFactories.icloudDownload(deps, ...)` | `ICloudDownloadService` | while the mobile graph is stored in iCloud |
| `syncEngines.create(options)` | the git sync engine of one backup | owned by its `BackupService` |
| `chatSessions.create({ session })` | `ChatSession` | one per graph session, every window (`GraphServices.chat`) |
| `capture.openSession({ generation })` | the capture drain and enrich loop | one per graph session, main window only |
| `assetDescription.openSession({ generation, indexGeneration })` | the asset description loop | same, desktop, while `describeAssets` is on |
| `attachments.watchCatalog(generation)` | the attachment catalog watch | one per graph session, every window |
| `audioMemo.openSession(...)` / `openPipeline(...)` | the recording surface and its transcription pipeline | one per workspace mount (`AudioMemoProvider`: it needs UI callbacks) |
| `noteSessions.create(options)` | `NoteSession` | one per open note pane |

The app-lifetime service keeps what is shared across sessions (its `deps`, its event
listeners such as `capture.onXPostsWritten`). A session exposes `start()` /
`dispose()`, and `getState()` / `subscribe()` when the UI reads it.

### `GraphSessionService`, `GraphSession`, and `generation`

`GraphSessionService` (`CoreServices.graphSession`, `graph/graph-session-service.ts`)
owns the active graph of a webview: status, recents, and the open, create, switch,
forget and delete flows. `GraphBootService` (`AppServices.graphBoot`) holds the
window-aware parts: the boot path, the folder picker, and closing note windows. `getState().session` is the open graph as one read-only
`GraphSession`: `{ root, name, generation, indexGeneration, signal }`. `signal` aborts
when the graph closes or another one replaces it.

Rust pins every write to a session with two independent counters: the file
`generation` (from `graph_open`) and the `indexGeneration` (from `index_open`). Rust
rejects a file write, and drops an index write, that carries a stale one, so a pass
that outlives a graph switch cannot land in the next graph.

`GraphSessionService` builds the graph-scoped container (`GraphServices`, through
`CoreAdapters.createGraphServices`) for each session and publishes it as `getState().services`; the app reads it with
`useGraphServices()`. It holds the per-graph lifecycles above. A background pass that
must stop with the graph checks `session.signal.aborted` (`indexLifecycle.sync(session)`).

Who holds the generation depends on the kind of service
([services.md](../contributing/services.md) §2, "The open graph"):

- **Rust-boundary wrappers** keep an explicit `generation` parameter
  (`noteFile.write(path, contents, generation)`), so a background pass writes with
  the session it started with.
- **User-facing services** take no `generation`. They read the session once at the
  entry of each public method (`graphSession.getState().session` or
  `requireGraphSession(graphSession)`) and pass its generations down
  (`NoteActionsService`). They never read it again after an `await`.
- **Background loops** get the `GraphSession` or its generations from
  `createGraphServices`.

### Events, not query-cache writes

`@reflect/core` does not know TanStack Query. A service that changes something the UI
caches **emits an event**: a method `onXxx(listener): Unlisten` (or
`subscribe(listener)` for a state store). Subscribing is synchronous. The desktop app
maps events to cache invalidation in a few small adapters:

| Event | Desktop adapter | Effect |
|---|---|---|
| `indexLifecycle.onApplied`, `onReconciled` | `lib/query-invalidation.ts` | invalidate index queries |
| `graphSession.onGraphReleased`, `onGraphDeleted` | `lib/query-invalidation.ts` | drop the similar notes and the iCloud listing |
| `capture.onXPostsWritten` | `lib/query-invalidation.ts` | invalidate X post queries |
| `assetDescription.onDescriptionsIndexed` | `lib/query-invalidation.ts` | invalidate index queries |
| `chatSessions.onConversationsChanged` | `lib/query-invalidation.ts` | invalidate chat history queries |
| `noteMove.onMoved` | `routing/router.tsx` | rewrite history entries to the new path |

Optimistic state is a core overlay (`NoteRowService`); the app only invalidates
queries. An action records what it writes (`noteActions.togglePinned` records
`isPinned` and `pinnedOrder`, `trash` records `trashed`), the desktop readers merge the
overlay over the index rows (`useNoteRow`, `useNoteRows`, `usePinnedNotes` in
`hooks/`), and each field retires once the index row agrees. A failed action drops
its overlay, so the index row is the truth again.

### Tests

A service is unit-tested by constructing it over test doubles from
`@reflect/core/testing` and `@reflect/app/testing`. No module mocks, no fake timers, no console spies. See
[docs/contributing/testing.md](../contributing/testing.md).

## 4. Kysely discipline (adopt fully)

- **`Selectable<T>` / `Insertable<T>` / `Updateable<T>`** for all read/insert/update types;
  **never raw table types** in function signatures.
- **`json()` helper** for any JSON-valued column (serialize objects/arrays correctly).
- **camelCase** TS surface over snake_case columns. Reflect runs SQLite in Rust with
  Kysely as a query-builder over IPC, so casing normalizes at the **zod/IPC boundary**
  (Plan 01); use Kysely's `CamelCasePlugin` if/where rows are mapped in JS.
- Timestamps surface as numbers/ISO strings deliberately (SQLite has no `Date`); document
  the choice in `packages/db`.

## 5. State management (frontend)

State is split **by kind**, not funneled through one global store. Match the tool to the
shape of the data:

- **Projection / IPC data** (notes, backlinks, search results, file lists) →
  **TanStack Query** (`@tanstack/react-query`). The `queryFn` calls a `@reflect/core`
  service method (`indexQuery`, `backlinks`, `search`, ...); the query options live in
  `apps/desktop/src/lib/query-options.ts` and take the service as `ctx`. Core services
  emit events when the index changes, and the desktop adapters of §3 turn them into
  **targeted `queryClient.invalidateQueries`** (`apps/desktop/src/lib/query-client.ts`).
  Optimistic state is a core overlay (`NoteRowService`) that readers merge over the
  cached rows; the app only invalidates queries, it never patches them. SQLite stays the single
  source of truth — **the frontend caches the projection, it never holds a second copy of it.**
- **Service-owned state** (settings, theme, the active graph and its recents, navigation
  history, backup status, operations, the chat session) → lives **in the service**
  that owns it (core or app), exposed as a snapshot getter plus `subscribe()` and read in React with
  `useServiceState` (a `useSyncExternalStore` wrapper). It is not mirrored into TanStack Query or a store.
- **Editor / document state** → owned by **meowdown/ProseMirror**; the `<Editor>` is
  uncontrolled, so this is never mirrored into a store.
- **Shared UI state** (command palette, sidebar + AI-context toggles, the focused daily)
  → **React context + hooks by default**. The contexts over service-owned state
  (`GraphProvider`) are thin shells
  that only forward the service. **Zustand** is in the toolbox for when
  a slice outgrows context — frequent updates that re-render too widely, or state needed far
  from where it's provided — but that's a per-slice judgement call, not a mandate. Reach for
  it when it earns its place; otherwise context suffices. Tradeoffs, as always.
- **Strictly-local ephemeral state** → plain React (`useState` / `useReducer`).

This composes with §3: service reads back query functions, service events invalidate.

**Non-goal:** a global observable domain model (MobX / MobX-Keystone style) that mirrors the
graph and notes in memory. V1 did this; in V2 the domain model lives in files → SQLite, so an
in-memory mirror only duplicates the projection and reintroduces watcher-sync complexity for
no benefit. MobX's fine-grained reactivity pays off over a rich client-owned model — which we
deliberately don't have.

## Consequences for specific plans

- **Plan 01** restructures the scaffold into `apps/desktop` + `packages/core` +
  `packages/db` and stands up Turbo/workspace/project-refs. The IPC boundary and the
  services live in `@reflect/core`.
- **Plan 04** keeps SQLite in Rust (primitive); the **read services** live in `core`; Kysely
  discipline above applies.
- **Plan 14 (CLI)** is a **self-contained Rust binary** (`apps/cli`, bin `reflect`) that
  reads the markdown files and opens `.reflect/index.sqlite` read-only itself — no Node
  runtime, no running desktop app. It deliberately duplicates the thin read-side contract
  (paths, fold keys, frontmatter, hashes) under parity tests; bundled with the app as a
  Tauri sidecar. (Supersedes the earlier Node-TS-CLI decision; rationale in Plan 14.)
- **Plans 02, 09, 10, 12** follow the primitive/policy split in §2 (Rust does FS/embed/git/
  keychain; core does orchestration, retrieval, AI, and conflict policy).
- **Plan 11 (extension)** lives in `apps/extension`; all durable writes/AI go through
  `apps/desktop` + `@reflect/core` services.
