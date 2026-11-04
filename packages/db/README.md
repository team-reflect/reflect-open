# @reflect/db

The Kysely schema and dialect for Reflect's local SQLite index.

## Design

SQLite runs **in Rust** (it's a native capability); this package only gives
TypeScript a typed query *builder* over it. `createDb(runQuery)` compiles each
query and hands it to the injected runner: in the app, `@reflect/core`'s
`DatabaseService` over the `db_query` IPC command; in tests, a real in-memory
SQLite index (`createNodeTestDatabaseService()` from `@reflect/core/testing`). The
package itself has no transport dependency.

Two properties are load-bearing:

- **Read-only.** All index writes go through the transactional `index_*`
  commands in Rust, carrying a generation token. The dialect rejects
  transactions, and Rust independently rejects any mutating SQL arriving via
  `db_query` — so the query surface can never write, even if miscompiled.
- **camelCase ↔ snake_case at this boundary.** Kysely's `CamelCasePlugin` maps
  the camelCase `Database` interface to the snake_case Rust schema. Nothing else
  in the codebase translates casing.

Timestamps surface as **epoch-millisecond numbers** (SQLite has no date type);
booleans as **`0 | 1` integers** — readers map them to real booleans in the
read services (see `NoteRow.isPrivate` in `@reflect/core`).

## Schema generation

`Database` types are generated from the Rust migrations by
`pnpm --filter @reflect/db db:codegen`. Never hand-edit `src/schema.gen.ts`; add a
migration in `crates/index-schema/migrations/` and regenerate.
