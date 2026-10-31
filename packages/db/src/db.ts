import { CamelCasePlugin, Kysely } from 'kysely'
import { IpcDialect, type QueryRunner } from './dialect.ts'
import type { Database } from './schema.ts'

/**
 * Build a Kysely instance over an injected {@link QueryRunner}. The
 * `CamelCasePlugin` maps the camelCase {@link Database} interface to the
 * snake_case columns/tables in the Rust schema (and result rows back to
 * camelCase).
 *
 * `@reflect/core` owns the shared instance wired to the IPC bridge; tests and
 * other hosts (e.g. the Plan 14 CLI reading the index file directly) construct
 * their own with a suitable runner.
 */
export function createDb(runQuery: QueryRunner): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new IpcDialect(runQuery),
    plugins: [new CamelCasePlugin()],
  })
}
