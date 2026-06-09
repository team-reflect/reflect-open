# Architecture & Conventions

Cross-cutting conventions for the whole codebase, adapted from
[`~/repos/picardo`](https://github.com/) (a separate app with battle-tested structure).
These four decisions were made deliberately and apply to **every** plan; individual
phase plans reference this doc rather than restating it.

| Decision | Choice |
|---|---|
| Repo structure | **Turborepo monorepo, adopted now (lightweight)** |
| Business-logic home | **TypeScript `core`; Rust = native primitives** |
| Code organization | **Per-domain "actions" pattern, reframed for local-first** |
| Database access | **Full Kysely discipline** (`Selectable/Insertable/Updateable`, `json()`, camelCase) |

## 1. Monorepo layout (adopt now, lightweight)

Turborepo + pnpm workspaces, `@reflect/*` package names, `tsc -b` project references
(kept in sync with `monorepo-typescript-references`-style tooling). Start with the
minimum set of packages and add `apps/cli` / `apps/extension` when their phases land —
not as empty stubs up front.

```
reflect-open/
├── apps/
│   ├── desktop/          # Tauri app — src/ (React) + src-tauri/ (Rust primitives)
│   ├── cli/              # Node TS CLI (Plan 14) — reuses @reflect/core; added at Plan 14
│   └── extension/        # Chrome MV3 capture extension (Plan 11) — added at Plan 11
├── packages/
│   ├── core/             # ALL TS business logic: actions/<domain>/, the markdown layer
│   ├── db/               # Kysely schema/types + the IPC query-builder dialect
│   └── design-system/    # existing design tokens/components (already present)
├── docs/
└── turbo.json, pnpm-workspace.yaml, tsconfig (project refs)
```

**The load-bearing rule (from picardo):** *no business logic in the app shell.* In
Reflect that means **no file/DB/AI/sync logic in React components, hooks, or Tauri command
handlers.** Components and hooks call `@reflect/core` actions; Tauri `#[command]` handlers
are thin wrappers over native primitives. Picardo's "never write DB queries in a tRPC
router" becomes Reflect's "never write file/DB/AI logic in a component or a Rust command
handler — delegate to a core action."

## 2. TS core, Rust = primitives

Reflect has no server. The boundary runs between **TypeScript business logic** and a
**thin Rust primitive surface**, bridged by the Plan 01 IPC layer.

| Lives in `@reflect/core` (TypeScript) | Lives in `apps/desktop/src-tauri` (Rust primitive) |
|---|---|
| Reads (Kysely getters over IPC) | SQLite open/migrate/query/exec; FTS5 + sqlite-vec extension loading |
| Orchestration of file writes + reindex | Atomic file IO, OS-trash delete, path-traversal guard, file watching |
| AI/provider calls, context assembly, patchsets | Local embedding runtime (model download + `embed`) |
| Privacy/capability guards (`private: true`) | Git operations (libgit2), keychain get/set/delete |
| Sync conflict normalization + resolution policy | Native menus, global shortcuts, dialogs |
| The markdown parse/serialize layer (Plan 03) | — |

Rust owns *capabilities*; TypeScript owns *policy and composition*. A Rust command never
encodes product rules beyond the primitive it exposes (e.g. the watcher emits events; it
doesn't decide what to reindex — a core action does). This keeps the same logic reusable
by `apps/cli` without going through the Rust process.

## 3. The actions pattern, reframed for local-first

Business logic is organized by **domain** under `packages/core/src/actions/<domain>/`,
using picardo's fixed file vocabulary — reframed because Reflect's source of truth is
markdown files, not a mutable DB.

First-wave domains: `graph`, `notes`, `daily`, `backlinks`, `search`, `embeddings`,
`ai`, `capture`, `sync`, `import-export`.

Each domain folder:

| File | Role in Reflect |
|---|---|
| `getters.ts` | **Reads** — Kysely queries over the IPC dialect against the SQLite projection. Return view interfaces; return `null` when absent (caller decides how to surface). |
| `setters.ts` | **Markdown mutations + reindex** — the durable write is a file edit (via Rust FS primitives + the Plan 03 minimal-diff helpers), followed by an index refresh. The DB is **read-only** from the app's perspective; "setting" means changing files. |
| `validators.ts` | Preconditions — zod shape checks + index-backed invariants (e.g. title uniqueness for rename). |
| `checkers.ts` | **Privacy/capability guards** (not authz — Reflect is single-user). `assertCloudAllowed(note)` is the canonical guard: the `private: true` hard-block. Also `assertProviderKeyPresent`, `assertEmbeddingRuntimeReady`. Composable and throwing, like picardo's `assertCan*`. |
| domain files | Complex logic (`rename.ts`, `slot`-style engines, `conflict.ts`). |
| `index.ts` | Barrel — the domain's public surface, re-exported from `@reflect/core`. |
| `README.md` | Module map for non-trivial domains (picardo's `visits/README.md` style). |
| `*.test.ts` | Colocated tests; tests are the documentation. |

**Apply the pattern as-needed, don't cargo-cult it.** Picardo earned 4-files-per-domain at
~90 domains; Reflect's first wave has ~10. Create only the files a domain actually needs
(`daily` may be getters-only; `checkers.ts` exists only where there's a real guard). The
vocabulary is the contract, not a mandatory file checklist.

**zod scope.** Validate at genuinely *external* boundaries — file contents, provider
responses, IPC command payloads crossing from Rust. Do **not** `zod.parse` every row of our
own SQLite projection (it's our schema, Rust-serialized); trust the Kysely types there.

### Function shape (dependency injection)

Every action takes a single destructured object including the injected handle(s) — the
Kysely `db` for reads, and a typed `fs`/IPC client for writes — mirroring picardo's
`{ db, ...args }` convention:

```ts
// packages/core/src/actions/notes/getters.ts
export async function getNoteById(
  { db, id }: { db: Kysely<Database>; id: string },
): Promise<NoteView | null> { /* Kysely read over IPC */ }

// packages/core/src/actions/notes/setters.ts — a "setter" is a markdown mutation
export async function renameNote(
  { fs, db, id, title }: { fs: FsClient; db: Kysely<Database>; id: string; title: string },
): Promise<void> {
  // 1. minimal-diff edits to files (Plan 03) via fs primitives
  // 2. request reindex of affected notes (Plan 04)
}

// packages/core/src/actions/ai/checkers.ts — the privacy hard-block as a checker
export function assertCloudAllowed(note: { isPrivate: boolean }): void {
  if (note.isPrivate) {
    throw new ReflectError({ kind: 'private-blocked', message: 'Note is marked private: true.' })
  }
}
```

`ReflectError` is the shared discriminated-union error contract (Plan 01's `AppError`),
the analog of picardo's `TRPCError`.

## 4. Kysely discipline (adopt fully)

- **`Selectable<T>` / `Insertable<T>` / `Updateable<T>`** for all read/insert/update types;
  **never raw table types** in function signatures.
- **`json()` helper** for any JSON-valued column (serialize objects/arrays correctly).
- **camelCase** TS surface over snake_case columns. Reflect runs SQLite in Rust with
  Kysely as a query-builder over IPC, so casing normalizes at the **zod/IPC boundary**
  (Plan 01); use Kysely's `CamelCasePlugin` if/where rows are mapped in JS.
- Timestamps surface as numbers/ISO strings deliberately (SQLite has no `Date`); document
  the choice in `packages/db`.

## Consequences for specific plans

- **Plan 01** restructures the scaffold into `apps/desktop` + `packages/core` +
  `packages/db` and stands up Turbo/workspace/project-refs. The IPC boundary and the
  actions core live in `@reflect/core`.
- **Plan 04** keeps SQLite in Rust (primitive); **getters** live in `core`; Kysely
  discipline above applies.
- **Plan 14 (CLI)** becomes a **Node TS app** in `apps/cli` that reuses `@reflect/core`
  getters + the markdown layer and opens `.reflect/index.sqlite` read-only — it does **not**
  need the Rust process.
- **Plans 02, 09, 10, 12** follow the primitive/policy split in §2 (Rust does FS/embed/git/
  keychain; core does orchestration, retrieval, AI, and conflict policy).
- **Plan 11 (extension)** lives in `apps/extension`; all durable writes/AI go through
  `apps/desktop` + `@reflect/core` actions.
