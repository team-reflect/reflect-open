# Adding a native command

How a value travels from Rust to a React component, and every file you touch
to add a new command. The canonical in-tree example is `app_version` — a real
`#[tauri::command]`, a zod-validated response, no direct `invoke` in the UI —
and this guide walks the same path with a hypothetical `note_stat` command.

```
React component / hook
  └─ typed binding            packages/core/src/<domain>/commands.ts
       └─ call()              packages/core/src/ipc/invoke.ts   (zod validation)
            └─ bridge.invoke  packages/core/src/ipc/bridge.ts   (injected transport)
                 └─ Tauri IPC apps/desktop/src/lib/tauri-bridge.ts
                      └─ #[tauri::command]  apps/desktop/src-tauri/src/<module>.rs
```

Before writing any Rust, check whether you actually need a new command. Per
[architecture-conventions](../plans/architecture-conventions.md), Rust owns
**capabilities** (file IO, SQLite, watching, OS stores) and TypeScript owns
**policy**. If your feature is a new *rule* over existing primitives — a new
query shape, a different orchestration — it belongs in `@reflect/core`, built
on the commands that already exist.

## 1. The Rust command

Pick the module that owns the capability (`fs.rs` for graph file IO, `db/` for
the index, `settings.rs`, `recents.rs`, …) or add a new one for a genuinely new
capability. Commands are snake_case, return `AppResult<T>`, and serialize
camelCase:

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
  argument (from `graph_open`) and get the root via `root_for_generation`,
  which rejects stale ones — a write racing a graph switch fails loudly
  instead of landing in the wrong graph. A new mutating command must follow
  this pattern; read-only commands use `current_root`.
- **No product policy.** A command exposes a primitive. If you find yourself
  encoding "what to do when X", that decision belongs in `@reflect/core`.

Register it in `apps/desktop/src-tauri/src/lib.rs` inside
`tauri::generate_handler![...]` — forgetting this compiles fine and fails at
runtime with a "command not found" rejection.

Test the logic with `#[cfg(test)]` against the pure helper, not the command
wrapper: `settings.rs` is a good model — `settings_load`/`settings_save` are
two-liners over `load_from`/`save_to`, and the tests exercise those with
`tempfile`. Run with `cargo test` from `apps/desktop/src-tauri`.

## 2. The TypeScript binding

Every command gets a typed binding in `packages/core` — components never call
`invoke` or touch the bridge directly. In the matching domain module
(`graph/commands.ts`, `settings/commands.ts`, …):

```ts
import { z } from 'zod'
import { call } from '../ipc/invoke'

export const noteStatSchema = z.object({
  sizeBytes: z.number(),
  modifiedMs: z.number(),
})

export type NoteStat = z.infer<typeof noteStatSchema>

/** File metadata for one note (graph-relative path). */
export async function noteStat(path: string): Promise<NoteStat> {
  return call('note_stat', { path }, noteStatSchema)
}
```

- `call()` (`ipc/invoke.ts`) is the single boundary where the untyped IPC
  response becomes a typed value: it validates with your schema (a mismatch
  throws a `parse` `AppError` naming the command) and coerces any rejection
  into an `AppError`. Your binding adds no error handling of its own.
- Commands returning `()` from Rust serialize as `null`: validate with
  `z.null()` (see the `voidSchema` convention in `graph/commands.ts`).
- Schemas live next to the binding (or in the domain's `schemas.ts` when
  shared) — zod at the boundary, plain types inside.
- Export the binding (and its types) from `packages/core/src/index.ts`; the
  apps only import from the package root.

## 3. Tests on the TS side

`@reflect/core` never imports Tauri, so tests install a fake bridge instead of
module-mocking:

```ts
import { setBridge } from '@reflect/core' // or '../ipc/bridge' within core
setBridge({
  invoke: vi.fn().mockResolvedValue({ sizeBytes: 12, modifiedMs: 99 }),
  listen: async () => () => {},
})
```

`packages/core/src/ipc/invoke.test.ts` shows the full pattern, including the
error paths (well-formed `AppError` pass-through, foreign rejection coercion,
schema-mismatch → `parse`). Reset with `setBridge(null)` in `afterEach`. A
binding that is a one-line `call()` needs no test of its own — cover the
schema if it normalizes, and the behavior in whatever core/UI module consumes
it.

## Checklist

- [ ] Rust: command in the owning capability module, returns `AppResult<T>`,
      camelCase serde, traversal-guarded paths, generation-pinned if mutating
- [ ] Rust: registered in `lib.rs` `generate_handler!`
- [ ] Rust: `#[cfg(test)]` tests on the pure helper; `cargo test` passes
- [ ] TS: zod schema + typed binding through `call()` in the domain module
- [ ] TS: exported from `packages/core/src/index.ts`
- [ ] TS: behavior covered with a fake bridge where it matters
- [ ] `pnpm typecheck && pnpm lint && pnpm test --run <touched paths>`
