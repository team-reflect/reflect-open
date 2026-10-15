# Adding a service

All stateful TypeScript logic is a **service**. Two composition roots build
every service once and pass each one the services it calls. There are no global
instances. The conventions are in
[architecture-conventions](../plans/architecture-conventions.md) §3. This guide
walks through adding one, with `NoteMoveService`
(`packages/core/src/documents/note-move-service.ts`) as the running example.

```text
packages/core/src/documents/note-move-service.ts       deps + interface + class + factory
packages/core/src/documents/note-move-service.test.ts  the real service over test doubles of its deps
packages/core/src/testing/documents.ts                 createTestNoteMoveService
packages/core/src/create-core-services.ts              CoreServices.noteMove
packages/core/src/testing/services.ts                  the test factory table
apps/desktop/src/routing/router.tsx                    useCoreServices().noteMove
```

## Do you need a service?

- **A pure rule** (a path helper, a markdown transform, a grouping) is a plain
  exported function.
- **A new operation in an existing domain** is a new method on the service that
  owns the domain. A new Rust command is this case: see
  [adding-a-command](adding-a-command.md).
- **A new service** is for a new unit with its own dependencies or its own
  state: a cache, a queue, a set of listeners, a lifecycle.

## Core, app, or desktop?

Ask the questions in order. The first "yes" decides.

| Question | Kind | Package | Example |
| --- | --- | --- | --- |
| Is it a thin wrapper over a Rust command, a Tauri plugin or a Web API, with no product rule? | Platform primitive | `@reflect/core` over `ipc`, or an adapter interface that `apps/desktop` implements | `NoteFileService` |
| Does it know windows, routes, scrolling, focus, key events, menus, pixels or toasts? | Interaction | `@reflect/app`; code that needs React stays in `apps/desktop` | `NavigationService` |
| Is it the app's policy for reporting errors, updating itself or quitting, with no caller in core? | App shell | `@reflect/app` | `UpdateService` |
| Must it behave the same in another client (a CLI, a watch, a share extension)? | Business | `@reflect/core` | `TaskService` |

When only part of a service passes the last question, split it: the business
part stays in core, the rest goes to app (`DeepLinkIntakeService` and
`DeepLinkRouter`, `GraphSessionService` and `GraphBootService`).

Two rules settle the hard cases:

- **The protocol is business, the route is interaction.** The `reflect://`
  syntax (`packages/core/src/navigation/deep-link-parse.ts`) stays in core,
  because other clients produce it. `Route`, and which `Route` a deep link
  opens (`packages/app/src/navigation/deep-link-route.ts`), belong to app.
- **A port is not the shell.** When core has a business caller, core defines
  the interface and someone else implements it: `LoggerService` (the host),
  `ProgressPort` (the app's `OperationsService`). `ExceptionTelemetryService`
  has no caller in core, so it lives in app.

Code in `packages/app` uses the same service shape as core. Lint stops both
packages from importing React, TanStack or Tauri, and core from importing
`@reflect/app`.

## 1. The interface, the class and the factory

One file, `<package>/src/<domain>/<name>-service.ts`, exports the deps interface
`XxxServiceDeps`, the interface `XxxService` and the factory
`createXxxService(deps)`. The class `XxxServiceImpl` implements the interface
and is not exported:

```ts
export interface NoteMoveServiceDeps {
  readonly ipc: IpcBridgeService
  readonly indexStore: IndexStoreService
  readonly openDocuments: OpenDocumentsService
  readonly logger: LoggerService
}

export interface NoteMoveService {
  /**
   * Move a note's file and projection, carrying any live editor session along.
   */
  moveNote(from: string, to: string, generation: number): Promise<void>
  /**
   * Subscribe to landed note moves; returns the unsubscribe.
   */
  onMoved(listener: NoteMovedListener): Unlisten
  // ...
}

class NoteMoveServiceImpl implements NoteMoveService {
  readonly #deps: NoteMoveServiceDeps
  readonly #listeners = new Set<NoteMovedListener>()

  constructor(deps: NoteMoveServiceDeps) {
    this.#deps = deps
  }

  async moveNote(from: string, to: string, generation: number): Promise<void> {
    // ...
  }
  // ...
}

export function createNoteMoveService(deps: NoteMoveServiceDeps): NoteMoveService {
  return new NoteMoveServiceImpl(deps)
}
```

Rules:

- Only the factory constructs the class. Callers see the interface.
- Document the interface, not the class. The interface never mentions `deps`.
- Class members keep this order: `#` fields, the constructor, the public
  members in the interface's order, `#` methods.
- A member is a plain method. Only a member that callers pass around without
  its object (`getState` and `subscribe`, read by
  `useServiceState(service, service.getState)`) is a function property in the
  interface and an arrow-function field in the class. Lint
  (`@typescript-eslint/unbound-method`) reports an unbound method. Wrap a
  one-off pass in an arrow at the call site.
- No getters, setters, overloads, `private`, `protected`, `public` or
  parameter properties. Lint enforces them.
- Assign a field that needs a constructor argument in the constructor body:
  field initializers run before the body.
- Never spread a service instance. A spread drops the prototype methods.
- A JSDoc comment is always multi-line, also for one sentence.
- Containers (`CoreServices`, `CoreInternalServices`, `MobileServices`,
  `GraphServices`, `AppServices`, `AppHost`) are not services. They stay plain
  interfaces and object literals.
- Throw `AppError` for failures a caller handles. Validate IPC responses and
  event payloads with zod (`noteMovedSchema`).

## 2. `deps`

`deps` is one object of type `XxxServiceDeps`, stored in `readonly #deps`. A
factory takes only `deps`. A per-session factory adds a second `options`
parameter for what identifies the session (§10).

- Put in it every collaborator: `ipc` for native commands, `logger` instead of
  `console.*`, `clock` instead of `Date.now()` and `setTimeout`, `id` instead
  of `crypto.randomUUID()`, `http` instead of `fetch`. A test controls them.
- Declare each dependency as the full service type (`LoggerService`, not
  `Pick<LoggerService, 'error'>`). List only the services the class uses.
- Do not import another service's instance, and do not read a global.
- If two services need each other, one takes a narrow function in `deps`, or
  the shared part becomes a third service.

### The open graph

Rust rejects a graph write whose `generation` is not the open graph's. Index
writes carry `indexGeneration` the same way.

- **Rust-boundary wrappers** take an explicit `generation` parameter.
  `NoteFileService` is the model: `write(path, contents, generation)`.
- **User-facing services** take `graphSession: GraphSessionSource` in `deps`
  and read the session once, at the entry of each public method
  (`graphSession.getState().session`, or `requireGraphSession(graphSession)` in
  `packages/core/src/graph/graph-session.ts`). Pass its generations to every
  lower call. Do not read the session again after an `await`.
- **Background loops** get the `GraphSession` from `createGraphServices` (§10).

`indexGeneration` is `null` when the index failed to open: skip the index write.

## 3. Where state lives

State is a `#` field of the class. Module-level `let` and caches are not
allowed: two tests, or two webviews, would share them. If the UI reads the
state, expose a store: a snapshot getter that returns the same object until
something changes, plus `subscribe(listener): Unlisten`.

## 4. Events

A service does not know about the UI's caches. It emits an event instead:

- The method is `onXxx(listener): Unlisten` and registers synchronously.
- Isolate listeners: wrap each call in `try` / `catch` and log, so one throwing
  subscriber does not turn a landed change into a failure.
- Optimistic state is a core overlay (`NoteRowService`). The UI only
  invalidates queries. Do not add a callback for the UI to patch its cache.

The desktop app decides what an event means for it: `lib/query-invalidation.ts`
invalidates queries on `indexLifecycle.onApplied`.

## 5. Add it to a composition root

There are two roots. `apps/desktop/src/boot.ts` builds them in this order:

1. The shared primitives: `logger`, `clock`, `ipc`.
2. The host: `createDesktopHost` builds the app services that core needs as
   ports (`window`, `lifecycle`, `operations`) plus the other `AppHost` fields.
3. Core: `createCoreServices(adapters)`. `createDesktopAdapters` supplies the
   `CoreAdapters`. The ports come from the host: `progress` is
   `host.operations`, `activity` is `host.lifecycle`, `role` comes from
   `host.window.isMainWindow()`.
4. App: `createAppServices(core, host)`.

A port is an interface in `packages/core/src/ports/` (`activity-port.ts`,
`progress-port.ts`) that core calls and an app service implements. `role` (`'main'` or `'note-window'`) replaces every
window check in core.

**Core layout.** The composition roots sit in `packages/core/src/`. Host ports and
their default implementations sit in `packages/core/src/ports/`. Everything else
sits in a domain directory. A file that exports a service is named after it:
`createXxxService` lives in `xxx-service.ts`.

**A core service**, in `packages/core/src/create-core-services.ts`:

1. Add the field to `CoreServices`, and its key to `SERVICE_KEYS` in
   `create-core-services.test.ts`.
2. Add the factory to `coreServiceFactories`.
3. Build it in `composeCoreServices` through the table, after the services it
   depends on: `const noteMove = create.noteMove({ ipc, indexStore, openDocuments, logger })`.
4. Export from `packages/core/src/index.ts` only the names another
   package imports. Apps import only from the package root and `/testing`.

A service that only other services use stays a local and goes in
`CoreInternalServices`, so tests still reach it. A mobile-only service goes in
`MobileServices` (`CoreServices.mobile`, `null` off mobile), built in
`buildMobileServices()`.

**An app service**, in `packages/app/src/create-app-services.ts`: add the field
to `AppServices`, and build it in `createAppServices` from `core.<x>`,
`host.<x>`, or app services built earlier in the function. Add its key to the
list in `create-app-services.test.ts`, and export its names from
`packages/app/src/index.ts`.

## 6. The test double

By default a service in a test is the **real service** over the test doubles of
its dependencies. Add a double only when the real service cannot run in a test,
or a test must script or observe it:

- **In-memory fake** for a service at the edge: files
  (`createTestNoteFileService`), IPC, HTTP, the clock, the database.
- **Scripted fake** for an answer that comes from outside: the language model,
  transcription.
- **Recording wrapper** around the real service, when tests read what it did
  (`moved()`, `calls()`) or seed its state (`setGraph()`).

Rules:

- Do not write a `createTestXxxService` that only calls `createXxxService` over
  default doubles.
- A recording wrapper is a class `TestXxxServiceImpl implements TestXxxService`
  that holds the real service in `#inner` and forwards every member explicitly
  (`TestNoteMoveServiceImpl` in `packages/core/src/testing/documents.ts`).
- `TestXxxService extends XxxService`. The extra members only observe or seed
  and drive. They never change what the real methods mean.
- A core double goes in the test factory table of
  `packages/core/src/testing/services.ts`, so `createTestCoreServices()` builds
  it. An app double goes in `packages/app/src/testing/`, exported from its
  `index.ts`, and `createTestAppServices` uses it.

## 7. The test

The test is next to the service. It constructs the real service over test
doubles of its direct dependencies and asserts through the doubles
(`indexStore.calls()`, `logger.getErrors()`). No `vi.mock`, no fake timers, no
console spies. `note-move-service.test.ts` is the model. [Testing](testing.md)
covers the containers and `renderInApp`.

## 8. Use it from the app

**React.** Read core services with `useCoreServices()` and app services with
`useAppServices()` (`apps/desktop/src/services/services-provider.tsx`), and
destructure. A component that reads both calls both hooks. Do not add a
`useNoteMoveService()` hook.

```tsx
// apps/desktop/src/routing/router.tsx
const { noteMove } = useCoreServices()
useEffect(
  () => noteMove.onMoved((from, to) => navigation.noteMoved(from, to)),
  [navigation, noteMove],
)
```

- An event subscription is a `useEffect` that returns the unsubscribe.
- Read a store with `useServiceState(service, service.getState)`
  (`apps/desktop/src/services/use-service-state.ts`), where it is used. Read a
  graph-scoped instance from `useGraphServices()`. A provider exists only for
  an instance it creates (`AudioMemoProvider`).
- A query calls the service in its `queryFn`. Put the options in
  `apps/desktop/src/lib/query-options.ts`.

**Non-React modules** in `apps/desktop/src/lib/` take the services as
parameters: the services they use, or the container when they use three or
more. A module that needs both layers takes two
(`installQueryInvalidation(core, app)` in `lib/query-invalidation.ts`).

**Commands** read `context.services` (core) and `context.app` (app)
(`CommandContext` in `apps/desktop/src/lib/commands/types.ts`). Never import
`coreServices` or `appServices` from `boot.ts`: only `main.tsx` and the
platform roots do.

## 9. If it needs a platform API

A Rust command needs nothing new: take `ipc` in `deps` and call
`ipc.call(command, args, schema)`.

A JavaScript-side platform API (a Tauri plugin, a browser API that tests do not
have) needs an **adapter**, because the packages must not import
`@tauri-apps/*`. Where it goes depends on who calls it:

- **A core adapter.** Define the interface in core, add a field to
  `CoreAdapters`, and pass it from `createDesktopAdapters`
  (`apps/desktop/src/services/create-desktop-services.ts`). Example: `path`
  (`PathTransport`, implemented by `tauri-path.ts`).
- **An app host primitive.** Define the interface in app, add a field to
  `AppHost`, and pass it from `createDesktopHost`. Example: `updater`
  (`UpdaterAdapter` in `packages/app/src/app/update-service.ts`, implemented by
  `tauri-updater.ts`). Make the field optional when a host can lack it, and
  decide what the service does then.
- **A port.** When core must reach something the app layer owns, add an
  interface to `packages/core/src/ports/` and a field to `CoreAdapters`,
  and let an app service implement it (`ProgressPort` and `OperationsService`).

Implement the native side in `apps/desktop/src/services/` (plus a browser one
if plain-browser dev needs it) and a test double (`createTestUpdaterAdapter`).
Keep the adapter thin: every decision stays in the service.

## 10. When to make it a per-session factory

An app-scoped service lives as long as the webview. Make it a factory, or give
it an `openSession(options)` method, when an instance must start and stop with
something shorter-lived. Examples: a loop for one open graph (`createBackupService(deps, { generation, indexGeneration })`,
`capture.openSession({ generation })`), state that must not survive a graph
switch (`chatSessions.create({ session })`), or one instance per note pane
(`noteSessions.create(options)`).

- A per-graph factory goes in `graphServiceFactories`, and `GraphServicesDeps`
  carries its deps (`packages/core/src/create-graph-services.ts`).
- `createGraphServices(session, deps, flags)` builds the services of one
  session. The `GraphLifecycleFlags` pick the lifecycles that run.
  `GraphSessionService` calls `CoreAdapters.createGraphServices` when a graph
  reaches `ready`, and aborts `session.signal` when the graph closes. The
  container disposes everything it started on that abort.
- `createAppGraphServices` (`packages/app/src/graph/graph-lifecycles.ts`) is
  what the desktop passes there. It decides the flags from the window role and
  the platform, and toggles the lifecycles that follow a setting with
  `whileActive`.
- A background pass checks `session.signal.aborted`. The UI reads the result
  with `useGraphServices()`.

## Checklist

- [ ] The service is in the package that the "Core, app, or desktop?" table picks
- [ ] `<name>-service.ts`: `XxxServiceDeps`, a documented `XxxService`, an
      unexported `XxxServiceImpl` (`#` fields, plain methods), and
      `createXxxService(deps)`
- [ ] Every collaborator comes through `deps`, typed as the full service
- [ ] Core: in `coreServiceFactories`, built in `composeCoreServices`, on
      `CoreServices` (key in `SERVICE_KEYS`) or `CoreInternalServices`. App: on
      `AppServices`, built in `createAppServices`
- [ ] A test double only for a fake or a recording wrapper (§6)
- [ ] Read with `useCoreServices()` / `useAppServices()`, module parameters, or
      `CommandContext.services` / `.app`
- [ ] A platform API through `CoreAdapters`, `AppHost`, or a port (§9)
- [ ] `pnpm typecheck && pnpm lint && pnpm test --run <touched paths>`
