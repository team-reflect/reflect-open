import { createDb, type Database, type QueryRunner } from '@reflect/db'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { toAppError } from '../errors.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

export interface DatabaseServiceDeps {
  readonly ipc: IpcBridgeService
}

/**
 * Typed read-only queries over the active graph's SQLite index. Queries
 * compile in TypeScript and execute in Rust via the `db_query` command.
 * Transactions and streams are rejected: writes go through the `index_*`
 * commands, which run their own Rust transactions.
 */
export interface DatabaseService {
  /**
   * The Kysely instance whose queries execute through {@link runQuery}.
   */
  readonly db: Kysely<Database>
  /**
   * Execute one compiled query and resolve with its raw row array. A
   * rejection is an `AppError`.
   */
  readonly runQuery: QueryRunner
}

/**
 * Rows are the index's own projection, so they skip per-row validation; the
 * dialect still fails fast on a response that is not a row array.
 */
const rowsSchema = z.unknown()

class DatabaseServiceImpl implements DatabaseService {
  readonly db: Kysely<Database>
  readonly runQuery: QueryRunner

  constructor(deps: DatabaseServiceDeps) {
    const { ipc } = deps
    this.runQuery = async (sql, params) => {
      try {
        return await ipc.call('db_query', { sql, params: [...params] }, rowsSchema)
      } catch (error) {
        throw toAppError(error)
      }
    }
    this.db = createDb(this.runQuery)
  }
}

/**
 * A {@link DatabaseService} over the `db_query` command.
 */
export function createDatabaseService(deps: DatabaseServiceDeps): DatabaseService {
  return new DatabaseServiceImpl(deps)
}
