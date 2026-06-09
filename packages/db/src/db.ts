import { CamelCasePlugin, Kysely } from 'kysely'
import { IpcDialect } from './dialect'
import type { Database } from './schema'

/**
 * Build a Kysely instance bound to the IPC SQLite bridge. The `CamelCasePlugin`
 * maps the camelCase {@link Database} interface to the snake_case columns/tables
 * in the Rust schema (and result rows back to camelCase).
 */
export function createDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new IpcDialect(),
    plugins: [new CamelCasePlugin()],
  })
}

/** The shared query builder for the active graph's index. */
export const db = createDb()
