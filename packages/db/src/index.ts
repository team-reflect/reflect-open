/**
 * `@reflect/db` — the Kysely schema + the IPC query-builder dialect for the local
 * SQLite projection (Plan 04). SQLite runs in Rust; this package gives the
 * frontend typed, Kysely-built reads that execute over the `db_query` command.
 * Writes go through `@reflect/core`'s `index_*` command bindings.
 *
 * The table/view types in `Database` are generated from the Rust migrations
 * (`pnpm --filter @reflect/db db:codegen`); `schema.gen.ts` is the output.
 */
export { db, createDb } from './db'
export { IpcDialect } from './dialect'
export type { Database } from './schema'
