import { createDb, type Database } from '@reflect/db'
import type { Kysely } from 'kysely'
import { toAppError } from '../errors'
import { getBridge } from '../ipc/bridge'

export type IndexDatabase = Kysely<Database>

function createIndexDatabase(graphGeneration?: number): IndexDatabase {
  return createDb(async (sql, params) => {
    try {
      return await getBridge().invoke('db_query', {
        sql,
        params: [...params],
        ...(graphGeneration === undefined ? {} : { graphGeneration }),
      })
    } catch (error) {
      throw toAppError(error)
    }
  })
}

/**
 * The shared Kysely instance over the active graph's SQLite index. Queries
 * compile in TypeScript and execute in Rust via the `db_query` command.
 *
 * The runner resolves the bridge per query (not at module load), so this
 * instance is safe to create before {@link setBridge} runs — only executing a
 * query without a bridge throws. Rejections are coerced to the shared
 * {@link AppError} contract like every other command.
 */
export const db: IndexDatabase = createIndexDatabase()

/**
 * Read the derived index only while it still belongs to `graphGeneration`.
 * Graph and index sessions are rebound separately during a vault switch; the
 * native gate prevents a generation-pinned filesystem lookup from ever being
 * combined with rows from the newly opened vault.
 */
export function dbForGraphGeneration(graphGeneration: number): IndexDatabase {
  return createIndexDatabase(graphGeneration)
}
