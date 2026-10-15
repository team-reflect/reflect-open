# Adding a native command

How a value travels from Rust to a React component, and every file you touch
to add a new command. **Adding a command is two things: the Rust command, and
a method on the core service that owns the domain.** The canonical in-tree
example is `app_version`: a real `#[tauri::command]` (`lib.rs`), bound as
`AppInfoService.version()` (`packages/core/src/ports/app-info-service.ts`) with a
zod-validated response, and read in React by `useAppVersion()`
(`apps/desktop/src/hooks/use-app-version.ts`) through `useCoreServices()`. This
guide walks the same path with a hypothetical `note_stat` command.

```text
React component / hook        useCoreServices()
  └─ service method           packages/core/src/<domain>/<name>-service.ts
       └─ ipc.call            packages/core/src/ipc/ipc-service.ts  (zod validation)
            └─ transport.invoke   the `IpcBridge` given to `createCoreServices`
                 └─ Tauri IPC apps/desktop/src/services/tauri-ipc.ts
                      └─ #[tauri::command]  apps/desktop/src-tauri/src/<module>.rs
```

Before writing any Rust, check whether you actually need a new command. Per
[architecture-conventions](../plans/architecture-conventions.md), Rust owns
**capabilities** (file IO, SQLite, watching, OS stores) and TypeScript owns
**policy**. If your feature is a new *rule* over existing primitives — a new
query shape, a different orchestration — it belongs in `@reflect/core`, built
on the commands that already exist.

## 1. The Rust command

Pick the module that owns the capability (`fs/` for graph file IO, `db/` for
the index, `settings.rs`, `recents.rs`, `secrets.rs`, `git/`, `capture.rs`,
`embed.rs`, …) or add a new one for a genuinely new capability. Commands are
snake_case, return `AppResult<T>`, and serialize camelCase:

```rust
// apps/desktop/src-tauri/src/fs/mod.rs
use crate::error::AppResult;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStat {
    pub size_bytes: u64,
    pub modified_ms: u64,
}

/// Command: file metadata for one note (graph-relative path).
#[tauri::command]
pub fn note_stat(path: String, state: tauri::State<GraphState>) -> AppResult<NoteStat> {
    let root = current_root(&state)?;
    let resolved = resolve(&root, &path)?; // traversal guard — see below
    // ...
}
```

Conventions that matter here:

- **Errors are the shared contract.** Return `AppError` (`error.rs`); it
  serializes as `{ kind, message }` and the frontend branches on `kind`
  through the matching zod union in `packages/core/src/errors.ts`. Never
  return bare strings. `std::io::Error` and `rusqlite::Error` already convert
  via `From` (`?` just works); NotFound is mapped for you.
- **Paths must not escape the graph.** Anything taking a graph-relative path
  resolves it via `resolve()` (`fs/resolve.rs`), which rejects traversal and
  symlink escapes. Don't build paths by hand.
- **Writes are generation-pinned.** Mutating commands take a `generation`
  argument (from `graph_open`/`graph_create`) and get the root via
  `root_for_generation`, which rejects stale ones — a write racing a graph
  switch fails loudly instead of landing in the wrong graph. A new mutating
  command must follow this pattern.
- **Background reads may also pin.** UI reads for the currently open graph can
  use `current_root`, but a read that belongs to a background pass that can
  span a graph switch should accept `generation: Option<u64>` (or a required
  `generation`, if the pass always has one) and use the `root_for` pattern
  from `fs::note_read`/`asset_read`.
- **No product policy.** A command exposes a primitive. If you find yourself
  encoding "what to do when X", that decision belongs in `@reflect/core`.

Register it in `apps/desktop/src-tauri/src/lib.rs` inside
`tauri::generate_handler![...]` — forgetting this compiles fine and fails at
runtime with a "command not found" rejection.

Test the logic with `#[cfg(test)]` against the pure helper, not the command
wrapper: `settings.rs` is a good model — `settings_load`/`settings_save` are
two-liners over `load_from`/`save_to`, and the tests exercise those with
`tempfile`. From the repo root, stage the sidecars once before compiling the
desktop crate, then run the crate tests:

```bash
pnpm --filter @reflect/desktop sidecar
cargo test -p reflect-open
```

## 2. The service method

Every command is bound in `packages/core` as a **method of the service that
owns the domain**. Components never call `invoke` or touch the transport. The
service already has the `IpcBridgeService` in its `deps`.

`note_stat` is graph file IO, so it belongs to `NoteFileService`
(`packages/core/src/graph/note-file-service.ts`), next to `read`, `write` and
`exists`:

```ts
// packages/core/src/graph/note-file-service.ts
const noteStatSchema = z.object({
  sizeBytes: z.number(),
  modifiedMs: z.number(),
})

export type NoteStat = z.infer<typeof noteStatSchema>

export interface NoteFileService {
  // ...
  /** File metadata for one note (graph-relative path). */
  stat(path: string): Promise<NoteStat>
}

export function createNoteFileService(deps: {
  ipc: IpcBridgeService
  clock: ClockService
  fileChanges: FileChangeService
}): NoteFileService {
  const { ipc, clock, fileChanges } = deps
  return {
    // ...
    async stat(path) {
      return await ipc.call('note_stat', { path }, noteStatSchema)
    },
  }
}
```

- `IpcBridgeService.call` (`ipc/ipc-service.ts`) is the single boundary where
  the untyped IPC response becomes a typed value: it validates with your
  schema (a mismatch throws a `parse` `AppError` naming the command) and
  coerces any rejection into an `AppError`. Your method adds no error
  handling of its own.
- Commands returning `()` from Rust serialize as `null`: validate with
  `z.null()` (see the `voidSchema` convention in `settings/settings-service.ts`).
- Schemas live next to the service (or in the domain's `schemas.ts` when
  shared) — zod at the boundary, plain types inside.
- A mutating method takes `generation: number` and passes it to the command
  (`write(path, contents, generation)`).
- Export the new types that the app imports from
  `packages/core/src/index.ts`; the apps only import from the package root.
- **Update the service's test double.** `createTestNoteFileService`
  (`packages/core/src/testing/graph.ts`) is an in-memory implementation of the
  interface, so it needs a `stat` too, or `pnpm typecheck` fails. A double that
  is the real service over `createTestIpcBridgeService()` needs nothing.

Plain-browser dev (`pnpm dev` without the shell) has no Rust. Its in-memory
backend, `apps/desktop/src/dev/dev-bridge.ts`, answers commands by name and
rejects the ones it does not know. Add a `case` there if the feature must work
in that mode.

If no existing service owns the capability, add one: a small
`createXxxService({ ipc })` like `AppInfoService`, a field on `CoreServices`,
and a test double. [Adding a service](services.md) is the guide.

React then reaches the method through the service, as `useAppVersion()` does:

```ts
const { noteFile } = useCoreServices()
const stat = await noteFile.stat(path)
```

## 3. Tests on the TS side

`@reflect/core` never imports Tauri, so the test constructs the service over
an in-memory transport instead of module-mocking
(`packages/core/src/graph/note-file-service.test.ts` is the model):

```ts
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIpcBridgeService,
} from '@reflect/core/testing'

const ipc = createTestIpcBridgeService({
  commands: { note_stat: () => ({ sizeBytes: 12, modifiedMs: 99 }) },
})
const noteFile = createNoteFileService({
  ipc,
  clock: createTestClockService(),
  fileChanges: createTestFileChangeService(),
})

await expect(noteFile.stat('notes/a.md')).resolves.toEqual({ sizeBytes: 12, modifiedMs: 99 })
expect(ipc.calls()).toEqual([{ command: 'note_stat', args: { path: 'notes/a.md' } }])
```

`createTestIpcBridgeService()` is an in-memory `IpcBridgeService` with
`onCommand`, `emit`, and `calls()`.
`packages/core/src/ipc/ipc-service.test.ts` shows the error paths
(well-formed `AppError` pass-through, foreign rejection coercion,
schema-mismatch → `parse`). A method that is a one-line `ipc.call()` needs
little: cover the schema if it normalizes, and the behavior in whatever
core/UI module consumes it. [Testing](testing.md) covers the test doubles and
the desktop render helpers.

## Checklist

- [ ] Rust: command in the owning capability module, returns `AppResult<T>`,
      camelCase serde, traversal-guarded paths, generation-pinned if mutating
      (and pinned for background reads that can span a graph switch)
- [ ] Rust: registered in `lib.rs` `generate_handler!`
- [ ] Rust: `#[cfg(test)]` tests on the pure helper; `cargo test -p reflect-open`
      passes after staging sidecars when the desktop crate compiles
- [ ] TS: zod schema + typed method through `ipc.call()` on the service that
      owns the domain; `generation` parameter if mutating
- [ ] TS: the service's test double in `packages/core/src/testing/` updated;
      new types the app imports exported from `packages/core/src/index.ts`
- [ ] TS: a new service only if no existing one owns the capability
      ([services.md](services.md))
- [ ] TS: behavior covered over `createTestIpcBridgeService()` where it matters
- [ ] `pnpm typecheck && pnpm lint && pnpm test --run <touched paths>`
