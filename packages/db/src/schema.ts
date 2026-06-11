/**
 * The local SQLite projection's types.
 *
 * **Generated** from the Rust migrations (`crates/index-schema/migrations/`)
 * by `pnpm --filter @reflect/db db:codegen` — see `schema.gen.ts` (do not edit
 * that by hand). This module re-exports the generated `DB` as `Database` and is
 * where JSON-column `ColumnType` overrides would live if we add any. CI fails if
 * regenerating produces a diff, so these types can't drift from the schema.
 */
export type { DB as Database } from './schema.gen'
