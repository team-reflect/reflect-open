# Adding a native command

How a value travels from Rust to a React component. **Adding a command is two
things: the Rust command, and a method on the core service that owns the
domain.** This guide walks the path with a hypothetical `note_stat` command.

The Rust command is a method on `Core` in `crates/core` (crate `reflect-core`,
no Tauri). Two shells call it by name through `Core::dispatch`: the Tauri desktop
app and the Swift iOS shell.

```text
React component / hook        useCoreServices()
  └─ service method           packages/core/src/<domain>/<name>-service.ts
       └─ ipc.call            packages/core/src/ipc/ipc-service.ts  (typed by the command table)
            └─ transport.invoke   the `IpcBridge` given to `createCoreServices`
                 ├─ Tauri IPC apps/web/src/services/tauri-ipc.ts
                 └─ Swift IPC apps/web/src/services/swift-ipc.ts
                      └─ Core::dispatch     crates/core/src/lib.rs
                           └─ Core method   crates/core/src/<module>.rs
```

First check whether you need a new command. Per
[architecture-conventions](../plans/architecture-conventions.md), Rust owns
**capabilities** (file IO, SQLite, watching, OS stores) and TypeScript owns
**policy**. A new *rule* over existing primitives belongs in `@reflect/core`.

## 1. The Rust command

Put the method in the `crates/core` module that owns the capability (`fs/`,
`db.rs`, `git.rs`, `capture.rs`, `embed.rs`, …) or a new one. State that
commands share (the graph session, the index session, the background
assertions) is a field of `Core`. Commands are snake_case, return
`AppResult<T>` unless they cannot fail, and serialize camelCase:

A type that crosses the boundary lives in `crates/types`, so the generator
can print it for TypeScript and Swift:

```rust
// crates/types/src/graph.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteStat {
    pub size_bytes: u64,
    pub modified_ms: u64,
}
```

```rust
// crates/core/src/fs/mod.rs

impl Core {
    /// Command: file metadata for one note (graph-relative path).
    pub fn note_stat(&self, path: String) -> AppResult<NoteStat> {
        let root = current_root(&self.graph)?;
        let resolved = resolve(&root, &path)?; // traversal guard — see below
        // ...
    }
}
```

Then add its row to the command table. Both shells dispatch from it, and the
generator prints the args and result types from it:

```rust
// crates/types/src/commands.rs, in the `core` block: one row per command.
note_stat(path: String) -> NoteStat,
```

The argument names become the camelCase keys of the JSON arguments. A row for
an `async` method has `.await` before the arrow. A row for a method that
returns its value without `AppResult` has `infallible` before the arrow. The
result type must match the method: a mismatch fails to compile. Every command
runs on a blocking-pool thread, never on the main thread.

A command that exists only on the desktop (windows, menus) is a
`#[tauri::command]` in the Tauri crate. Its row goes in the `desktop` block as
`module::name(args) -> Result`, and lists only the arguments the frontend
sends. The Tauri handler is built from that block. Only the names are
checked: the compiler does not compare the row with the function signature.

A command that the Swift shell answers (`plugin:<name>|<command>`,
`host.<command>`) goes in the `shell` block as
`"name" => identifier(ArgsType) -> Result`. The arguments are one named type
from `crates/types/src/shell.rs` (`NoArgs` for none), so Swift can decode
them. Swift registers the handler under the camelCase
case of `ShellCommandName` (`recording_start` becomes `.recordingStart`).

Then regenerate the TypeScript and Swift types and commit the output:

```bash
pnpm gen:types
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

Test the pure helper with `#[cfg(test)]`, not the command wrapper.
`crates/core/src/settings.rs` is the model: `settings_load`/`settings_save`
wrap `load_from`/`save_to`, which the tests exercise with `tempfile`.

```bash
cargo test -p reflect-core
```

Stage the sidecars once before compiling the desktop crate
(`pnpm --filter @reflect/tauri sidecar`).

## 2. The service method

Bind every command as a **method of the core service that owns the domain**.
Components never call `invoke`. `note_stat` is graph file IO, so it belongs to
`NoteFileService` (`packages/core/src/graph/note-file-service.ts`), next to
`read` and `write`:

```ts
import type { NoteStat } from '@reflect/types'

export type { NoteStat }

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
    return await this.#deps.ipc.call('note_stat', { path })
  }
}
```

- `IpcBridgeService.call` takes its args and result types from the command
  table, and turns any rejection into an `AppError`. Your method adds no error
  handling. An `Option` argument is required as `T | null`.
- Pass a zod schema as the third argument only when the result needs a
  stricter check than its Rust type, for example data read from disk or the
  network (`settings_load`, `x_syndication_fetch`). A mismatch throws a `parse`
  `AppError` naming the command.
- `ipc.callBytes(command, args)` calls a command whose reply is raw bytes
  (`asset_read_binary`), and `ipc.callBinary` sends a raw byte body
  (`asset_upload_append`).
- A mutating method takes `generation: number` and passes it on
  (`write(path, contents, generation)`).
- Export new types the apps import from `packages/core/src/index.ts`.
- **Update the service's test double.** `createTestNoteFileService`
  (`packages/core/src/testing/graph.ts`) implements the interface in memory, so
  it needs `stat` too, or `pnpm typecheck` fails.

Plain-browser dev (`pnpm dev` without the shell) answers commands from
`apps/web/src/dev/dev-bridge.ts` and throws on unknown ones. Add a `case`
there if the feature must work in that mode, and read its args with
`argsOf(command, args)`.

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
`ipc.call()` method needs little: cover the behavior in the module that
consumes it. See [testing.md](testing.md).

## Checklist

- [ ] Rust: `Core` method in the owning `crates/core` module, `AppResult<T>`,
      camelCase serde, `resolve()`d paths, generation-pinned if mutating or a
      background read
- [ ] Rust: boundary types in `crates/types`, a row in the command table
      (`crates/types/src/commands.rs`), then `pnpm gen:types`
- [ ] Rust: `#[cfg(test)]` tests on the pure helper; `cargo test -p reflect-core`
- [ ] TS: method through `ipc.call()` on the owning service;
      `generation` parameter if mutating
- [ ] TS: test double updated; new types exported from `packages/core/src/index.ts`
- [ ] TS: behavior covered over `createTestIpcBridgeService()` where it matters
- [ ] `pnpm typecheck && pnpm lint && pnpm test --run <touched paths>`
