# Adding a native command

How a value travels from Rust to a React component. **Adding a command is two
things: the Rust command, and a method on the core service that owns the
domain.** The in-tree example is `app_version`: a `#[tauri::command]` in
`lib.rs`, bound as `AppInfoService.version()`
(`packages/core/src/ports/app-info-service.ts`), and read in React by
`useAppVersion()` (`apps/desktop/src/hooks/use-app-version.ts`). This guide
walks the same path with a hypothetical `note_stat` command.

```text
React component / hook        useCoreServices()
  └─ service method           packages/core/src/<domain>/<name>-service.ts
       └─ ipc.call            packages/core/src/ipc/ipc-service.ts  (zod validation)
            └─ transport.invoke   the `IpcBridge` given to `createCoreServices`
                 └─ Tauri IPC apps/desktop/src/services/tauri-ipc.ts
                      └─ #[tauri::command]  apps/desktop/src-tauri/src/<module>.rs
```

First check whether you need a new command. Per
[architecture-conventions](../plans/architecture-conventions.md), Rust owns
**capabilities** (file IO, SQLite, watching, OS stores) and TypeScript owns
**policy**. A new *rule* over existing primitives belongs in `@reflect/core`.

## 1. The Rust command

Put it in the module that owns the capability (`fs/`, `db/`, `settings.rs`,
`recents.rs`, `secrets.rs`, `git.rs`, `capture.rs`, `embed.rs`, …) or a new one.
Commands are snake_case, return `AppResult<T>`, and serialize camelCase:

```rust
// apps/desktop/src-tauri/src/fs/mod.rs
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

- **Errors are the shared contract.** Return `AppError` (from `reflect-types`,
  `crates/types/src/error.rs`). It serializes as `{ kind, message }`, and the
  frontend gets the `AppError` class (`packages/core/src/errors.ts`) and
  branches on `kind` with `isAppError`. Never return bare strings.
  `std::io::Error` and `rusqlite::Error` convert via `From`, so `?` works.
- **Paths must not escape the graph.** Resolve graph-relative paths with
  `resolve()` (`crates/graph-io/src/resolve.rs`), which rejects traversal and
  symlink escapes. Do not build paths by hand.
- **Writes are generation-pinned.** A mutating command takes the `generation`
  from `graph_open`/`graph_create` and gets the root via `root_for_generation`,
  which rejects stale ones. A write racing a graph switch then fails loudly
  instead of landing in the wrong graph.
- **Background reads may also pin.** UI reads of the open graph can use
  `current_root`. A read in a background pass that can span a graph switch
  takes `generation` (optional or required) and uses `root_for`, like
  `fs::note_read`/`asset_read`.
- **No product policy.** A command exposes a primitive. "What to do when X"
  belongs in `@reflect/core`.

Register it in `tauri::generate_handler![...]` in
`apps/desktop/src-tauri/src/lib.rs`. A missing registration compiles fine and
fails at runtime with "command not found".

Test the pure helper with `#[cfg(test)]`, not the command wrapper.
`settings.rs` is the model: `settings_load`/`settings_save` wrap
`load_from`/`save_to`, which the tests exercise with `tempfile`. Stage the
sidecars once before compiling the desktop crate:

```bash
pnpm --filter @reflect/desktop sidecar
cargo test -p reflect-open
```

## 2. The service method

Bind every command as a **method of the core service that owns the domain**.
Components never call `invoke`. `note_stat` is graph file IO, so it belongs to
`NoteFileService` (`packages/core/src/graph/note-file-service.ts`), next to
`read` and `write`:

```ts
const noteStatSchema = z.object({ sizeBytes: z.number(), modifiedMs: z.number() })

export type NoteStat = z.infer<typeof noteStatSchema>

export interface NoteFileService {
  // ...
  /**
   * File metadata for one note (graph-relative path).
   */
  stat(path: string): Promise<NoteStat>
}

class NoteFileServiceImpl implements NoteFileService {
  // ...
  async stat(path: string): Promise<NoteStat> {
    return await this.#deps.ipc.call('note_stat', { path }, noteStatSchema)
  }
}
```

- `IpcBridgeService.call` is the one place an IPC response becomes typed: a
  schema mismatch throws a `parse` `AppError` naming the command, and any
  rejection becomes an `AppError`. Your method adds no error handling.
- A command returning `()` serializes as `null`: validate with `z.null()`
  (`voidSchema` in `settings/settings-service.ts`).
- Schemas live next to the service, or in the domain's `schemas.ts` when
  shared.
- A mutating method takes `generation: number` and passes it on
  (`write(path, contents, generation)`).
- Export new types the apps import from `packages/core/src/index.ts`.
- **Update the service's test double.** `createTestNoteFileService`
  (`packages/core/src/testing/graph.ts`) implements the interface in memory, so
  it needs `stat` too, or `pnpm typecheck` fails.

Plain-browser dev (`pnpm dev` without the shell) answers commands from
`apps/desktop/src/dev/dev-bridge.ts` and throws on unknown ones. Add a `case`
there if the feature must work in that mode.

If no service owns the capability, add one: see [services.md](services.md).
React reaches the method through the service:

```ts
const { noteFile } = useCoreServices()
const stat = await noteFile.stat(path)
```

## 3. Tests on the TS side

Construct the service over an in-memory IPC instead of module mocks
(`packages/core/src/graph/note-file-service.test.ts` is the model):

```ts
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

`packages/core/src/ipc/ipc-service.test.ts` covers the error paths. A one-line
`ipc.call()` method needs little: cover the schema if it normalizes, and the
behavior in the module that consumes it. See [testing.md](testing.md).

## Checklist

- [ ] Rust: command in the owning module, `AppResult<T>`, camelCase serde,
      `resolve()`d paths, generation-pinned if mutating or a background read
- [ ] Rust: registered in `lib.rs` `generate_handler!`
- [ ] Rust: `#[cfg(test)]` tests on the pure helper; `cargo test -p reflect-open`
- [ ] TS: zod schema + method through `ipc.call()` on the owning service;
      `generation` parameter if mutating
- [ ] TS: test double updated; new types exported from `packages/core/src/index.ts`
- [ ] TS: behavior covered over `createTestIpcBridgeService()` where it matters
- [ ] `pnpm typecheck && pnpm lint && pnpm test --run <touched paths>`
