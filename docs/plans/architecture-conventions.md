# Architecture & Conventions

Cross-cutting conventions for the whole codebase, adapted from `~/repos/picardo` (a
separate first-party app with battle-tested structure).
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

```text
reflect-open/
├── apps/
│   ├── desktop/          # Tauri app — src/ (React) + src-tauri/ (Rust primitives)
│   ├── cli/              # Rust CLI (Plan 14) — self-contained `reflect` binary; added at Plan 14
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
doesn't decide what to reindex — a core action does). One deliberate exception: the CLI
(Plan 14) is a self-contained Rust binary that re-implements the small read-side contract
rather than reusing `@reflect/core` — see Plan 14 for the rationale and parity-test
guardrails.

## 3. The actions pattern, reframed for local-first

Business logic is organized by **domain** under `packages/core/src/actions/<domain>/`,
using picardo's fixed file vocabulary — reframed because Reflect's source of truth is
markdown files, not a mutable DB.

First-wave domains: `graph`, `notes`, `daily`, `backlinks`, `search`, `embeddings`,
`ai`, `capture`, `sync`.

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

## 5. State management (frontend)

State is split **by kind**, not funneled through one global store. Match the tool to the
shape of the data:

- **Projection / IPC data** (notes, backlinks, search results, file lists, recents) →
  **TanStack Query** (`@tanstack/react-query`). The `queryFn` is a `@reflect/core` getter;
  the file-watcher event (Plans 03/04) drives **targeted `queryClient.invalidateQueries`**,
  and setters (markdown writes) do optimistic update + invalidate. SQLite stays the single
  source of truth — **the frontend caches the projection, it never holds a second copy of it.**
- **Editor / document state** → owned by **meowdown/ProseMirror**; the `<Editor>` is
  uncontrolled, so this is never mirrored into a store.
- **Shared UI / session state** (theme, active graph, route model, command palette,
  sidebar + AI-context toggles, sync status) → **React context + hooks by default**
  (what `ThemeProvider`/`GraphProvider` already are). **Zustand** is in the toolbox for when
  a slice outgrows context — frequent updates that re-render too widely, or state needed far
  from where it's provided — but that's a per-slice judgement call, not a mandate. Reach for
  it when it earns its place; otherwise context suffices. Tradeoffs, as always.
- **Strictly-local ephemeral state** → plain React (`useState` / `useReducer`).

This composes with the actions pattern (§3): getters back query functions, setters invalidate.

**Non-goal:** a global observable domain model (MobX / MobX-Keystone style) that mirrors the
graph and notes in memory. V1 did this; in V2 the domain model lives in files → SQLite, so an
in-memory mirror only duplicates the projection and reintroduces watcher-sync complexity for
no benefit. MobX's fine-grained reactivity pays off over a rich client-owned model — which we
deliberately don't have.

## Consequences for specific plans

- **Plan 01** restructures the scaffold into `apps/desktop` + `packages/core` +
  `packages/db` and stands up Turbo/workspace/project-refs. The IPC boundary and the
  actions core live in `@reflect/core`.
- **Plan 04** keeps SQLite in Rust (primitive); **getters** live in `core`; Kysely
  discipline above applies.
- **Plan 14 (CLI)** is a **self-contained Rust binary** (`apps/cli`, bin `reflect`) that
  reads the markdown files and opens `.reflect/index.sqlite` read-only itself — no Node
  runtime, no running desktop app. It deliberately duplicates the thin read-side contract
  (paths, fold keys, frontmatter, hashes) under parity tests; bundled with the app as a
  Tauri sidecar. (Supersedes the earlier Node-TS-CLI decision; rationale in Plan 14.)
- **Plans 02, 09, 10, 12** follow the primitive/policy split in §2 (Rust does FS/embed/git/
  keychain; core does orchestration, retrieval, AI, and conflict policy).
- **Plan 11 (extension)** lives in `apps/extension`; all durable writes/AI go through
  `apps/desktop` + `@reflect/core` actions.
