# Architecture & Conventions

Cross-cutting conventions, adapted from `~/repos/picardo` (a first-party app with
battle-tested structure). These four decisions apply to **every** plan; phase plans
reference this doc instead of restating it.

| Decision | Choice |
|---|---|
| Repo structure | **Turborepo monorepo, adopted now (lightweight)** |
| Business-logic home | **TypeScript `core`; Rust = native primitives** |
| Code organization | **Per-domain services, built once by a composition root** |
| Database access | **Full Kysely discipline** (`Selectable/Insertable/Updateable`, `json()`, camelCase) |

## 1. Monorepo layout (adopt now, lightweight)

Turborepo + pnpm workspaces, `@reflect/*` names, `tsc -b` project references. Start with
the minimum packages; add `apps/cli` / `apps/extension` when their phases land, not as
empty stubs.

```text
reflect-open/
├── apps/
│   ├── desktop/          # Tauri app — src/ (React) + src-tauri/ (Rust primitives)
│   ├── cli/              # Rust CLI (Plan 14)
│   └── extension/        # Chrome MV3 capture extension (Plan 11)
├── packages/
│   ├── core/             # ALL TS business logic + the markdown layer
│   ├── app/              # app layer: windows, routes, commands, menus, update, boot flows
│   ├── db/               # Kysely schema/types + the IPC query-builder dialect
│   └── design-system/
└── docs/
```

**The load-bearing rule (from picardo):** *no business logic in the app shell.* No
file/DB/AI/sync logic in React components, hooks, or Tauri command handlers. Components
call `@reflect/core` services; `#[command]` handlers are thin wrappers over primitives.
No windows, routes, menus, or pixels in core: those belong to `@reflect/app`.

## 2. TS core, Rust = primitives

Reflect has no server. The boundary runs between **TypeScript business logic** and a
**thin Rust primitive surface**, bridged by `IpcBridgeService`.

| `@reflect/core` (TS) | `@reflect/app` (TS) | `src-tauri` (Rust primitive) |
|---|---|---|
| Reads (Kysely over IPC) | Navigation history, `Route`, deep-link targets | SQLite open/migrate/query; FTS5 + sqlite-vec loading |
| File-write orchestration + reindex | Windows, lifecycle, quit/background policy | Atomic IO, OS trash, path-traversal guard, watching |
| AI calls, context assembly, patchsets | Commands, keymap, menus, palette search | Local embedding runtime |
| Privacy guards (`private: true`) | Operations list, update, theme, telemetry | Git (libgit2), keychain |
| Sync conflict policy | Graph boot flows, mobile onboarding | Native menus, global shortcuts, dialogs |
| Markdown parse/serialize (Plan 03) | | |

Rust owns *capabilities*; TypeScript owns *policy and composition*. A Rust command
encodes no product rules (the watcher emits events; `IndexLifecycleService` decides what
to reindex). One deliberate exception: the CLI (Plan 14) is a self-contained Rust binary
that re-implements the small read-side contract (rationale and parity tests in Plan 14).

## 3. Services and the composition root

Logic is organized by **domain** under `packages/core/src/<domain>/` (and
`packages/app/src/<domain>/`). Each domain exposes **services**. There are no process-wide
instances and no module-level mutable state: two composition roots build every service
once and pass each what it needs. [docs/contributing/services.md](../contributing/services.md)
is the step-by-step guide.

### What a service is

- `XxxService` interface, `XxxServiceDeps`, an unexported `XxxServiceImpl`, and
  `createXxxService(deps)` in `<domain>/<name>-service.ts`. State lives in `#` fields;
  callers see only the interface.
- `deps` is one object holding the other services it calls. A service never imports
  another service's instance.
- Pure rules stay plain exported functions with no `deps`. The few that need a service
  take it as a first `ctx` parameter.

**zod scope.** Validate genuinely *external* data: file contents, provider responses, IPC
responses from Rust. Do **not** `zod.parse` every row of our own SQLite projection.

**Errors.** Services throw the shared `AppError`; its `kind` is the contract Rust
serializes.

**Privacy guards.** The `private: true` block is a type, not a convention: a
`CloudSafe<T>` is minted only by the privacy gate, and every provider-bound input
requires one.

### Three packages and two roots

- `@reflect/core`: business logic and primitive interfaces. `createCoreServices(adapters)`.
  Core never imports `@tauri-apps/*`; the host supplies `CoreAdapters`.
- `@reflect/app`: `createAppServices(core, host)` over the core services.
- `apps/desktop`: React and the adapters (`src/services/`: `tauri-*` and `browser-*`
  for `pnpm dev` without the shell). `boot.ts` builds primitives, host, core, then app.
  Lint keeps React, TanStack, and Tauri out of both packages, and `@reflect/app` out of
  core.

A **port** (`packages/core/src/ports/`) is an interface core calls and an app service
implements. Mobile-only services live in `CoreServices.mobile` (`null` elsewhere).

### How code reaches a service

- **Core:** through `deps`, nothing else.
- **React:** `useCoreServices()` / `useAppServices()` (and `useMobileServices()` on
  mobile). Do not add per-service hooks.
- **Non-React desktop modules:** leading parameters are the services used (or the
  containers when three or more).
- **Commands:** read services from `CommandContext`, never from an import.

Providers are thin shells over service state; the state machines are in core.
(`RouterProvider` uses `subscribe` + `useState` because a `useSyncExternalStore` update
inside a transition still commits the `Suspense` fallback of a lazy screen.)

### Per-session factories

Some work belongs to one graph session: it starts when a graph opens and must stop, with
its timers and subscriptions, when it closes. Building it once per app would let a pass
or pending turn of the previous graph leak into the next. So factories build one instance
per `GraphSession` and dispose it when `session.signal` aborts. See
`packages/core/src/create-graph-services.ts` and
`packages/app/src/graph/graph-lifecycles.ts` (which picks lifecycles by window role). The
app-lifetime service keeps what is shared across sessions.

### `GraphSession` and `generation`

`GraphSessionService` owns a webview's active graph; `GraphBootService` holds the
window-aware parts. The open graph is a read-only `GraphSession` (`root`, `name`,
`generation`, `indexGeneration`, `signal`).

Rust pins every write to a session with two counters: file `generation` and
`indexGeneration`. Rust rejects a file write, and drops an index write, with a stale one,
so a pass that outlives a graph switch cannot land in the next graph.

Who holds the generation ([services.md](../contributing/services.md) §2):

- **Rust-boundary wrappers** take an explicit `generation`, so a background pass writes
  with the session it started with.
- **User-facing services** read the session once at method entry and pass it down. They
  never read it again after an `await`.
- **Background loops** get it from `createGraphServices`.

### Events, not query-cache writes

`@reflect/core` does not know TanStack Query. A service that changes cached data **emits
an event** (`onXxx(listener): Unlisten`, or `subscribe`). Small desktop adapters map events
to invalidation (`apps/desktop/src/lib/query-invalidation.ts`, plus history rewrites on
move in `routing/router.tsx`).

Optimistic state is a core overlay (`NoteRowService`): an action records what it writes,
readers merge the overlay over index rows, each field retires once the index agrees, and
a failed action drops its overlay. The app only invalidates queries, never patches them.

### Tests

Construct services over doubles from `@reflect/core/testing` and `@reflect/app/testing`.
No module mocks, no fake timers, no console spies. See
[docs/contributing/testing.md](../contributing/testing.md).

## 4. Kysely discipline (adopt fully)

- **`Selectable<T>` / `Insertable<T>` / `Updateable<T>`**; **never raw table types** in
  signatures.
- **`json()`** for JSON-valued columns.
- **camelCase** TS over snake_case columns, normalized at the zod/IPC boundary (SQLite
  runs in Rust).
- Timestamps surface as numbers/ISO strings deliberately (SQLite has no `Date`).

## 5. State management (frontend)

State is split **by kind**, not funneled through one store:

- **Projection / IPC data** → **TanStack Query**. `queryFn`s call core services; query
  options live in `apps/desktop/src/lib/query-options.ts`; core events drive targeted
  invalidation. SQLite stays the single source of truth: **the frontend caches the
  projection, it never holds a second copy.**
- **Service-owned state** (settings, theme, active graph, history, backup status,
  operations, chat) → lives **in the service** as a snapshot + `subscribe()`, read with
  `useServiceState`. Not mirrored into a query cache or store.
- **Editor state** → owned by meowdown/ProseMirror (the `<Editor>` is uncontrolled).
- **Shared UI state** → **React context + hooks by default**. **Zustand** is available
  when a slice outgrows context (frequent updates re-rendering too widely, or state needed
  far from its provider). A per-slice judgement call, not a mandate.
- **Local ephemeral state** → `useState` / `useReducer`.

**Non-goal:** a global observable domain model (MobX style) mirroring the graph in memory.
V1 did this; in V2 the model lives in files → SQLite, so a mirror only duplicates the
projection and reintroduces watcher-sync complexity. MobX's fine-grained reactivity pays
off over a rich client-owned model, which we deliberately do not have.

## Consequences for specific plans

- **Plan 01** restructures the scaffold into `apps/desktop` + `packages/core` +
  `packages/db` with Turbo and project refs.
- **Plan 04** keeps SQLite in Rust; read services live in core.
- **Plan 14 (CLI)** is a **self-contained Rust binary** that reads markdown and opens
  `.reflect/index.sqlite` read-only itself: no Node runtime, no running app. It duplicates
  the thin read-side contract under parity tests and ships as a Tauri sidecar.
  (Supersedes the earlier Node CLI decision.)
- **Plans 02, 09, 10, 12** follow the §2 split (Rust: FS/embed/git/keychain; core:
  orchestration, retrieval, AI, conflict policy).
- **Plan 11** lives in `apps/extension`; durable writes/AI go through the desktop app and
  core services.
