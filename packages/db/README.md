# @reflect/db

The Kysely schema and dialect for Reflect's local SQLite index.

## Design

SQLite runs **in Rust** (it's a native capability); this package only gives
TypeScript a typed query *builder* over it. `createDb(runQuery)` returns a
Kysely instance whose dialect compiles each query to `{ sql, parameters }` and
hands it to the injected runner — in the app that's `@reflect/core`'s
`DatabaseService` over the `db_query` IPC command, in tests a real in-memory
SQLite index (`createNodeTestDatabaseService()` from `@reflect/core/testing`). The
package itself has no transport dependency.

Two properties are load-bearing:

- **Read-only.** All index writes go through the transactional `index_*`
  commands in Rust, carrying a generation token. The dialect rejects
  transactions, and Rust independently rejects any mutating SQL arriving via
  `db_query` — so the query surface can never write, even if miscompiled.
- **camelCase ↔ snake_case at this boundary.** The `Database` interface is
  camelCase; Kysely's `CamelCasePlugin` maps to the snake_case columns in the
  Rust schema and maps result rows back. Nothing else in the codebase
  translates casing.

Timestamps surface as **epoch-millisecond numbers** (SQLite has no date type);
booleans as **`0 | 1` integers** — readers map them to real booleans in the
read services (see `NoteRow.isPrivate` in `@reflect/core`).

## Schema generation

`Database` types are generated from the Rust migrations:

```bash
pnpm --filter @reflect/db db:codegen   # rebuilds src/schema.gen.ts
```

Never hand-edit `schema.gen.ts`; add a migration in
`apps/desktop/src-tauri/migrations/` and regenerate.
