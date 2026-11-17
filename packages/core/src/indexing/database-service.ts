import { createDb, type Database, type QueryRunner } from '@reflect/db'
import type { Kysely } from 'kysely'
import { toAppError } from '../errors.ts'
import type { IndexReadCommand } from '@reflect/types'
import type { CommandArgs, CommandResult, IpcBridgeService } from '../ipc/ipc-service.ts'

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
  /**
   * Run one read command of the index and resolve with its typed result. A
   * rejection is an `AppError`.
   */
  read<C extends IndexReadCommand>(command: C, args: CommandArgs<C>): Promise<CommandResult<C>>
}

class DatabaseServiceImpl implements DatabaseService {
  readonly db: Kysely<Database>
  readonly runQuery: QueryRunner
  readonly #ipc: IpcBridgeService

  constructor(deps: DatabaseServiceDeps) {
    const { ipc } = deps
    this.#ipc = ipc
    this.runQuery = async (sql, params) => {
      try {
        return await ipc.call('db_query', { sql, params: [...params] })
      } catch (error) {
        throw toAppError(error)
      }
    }
    this.db = createDb(this.runQuery)
  }

  async read<C extends IndexReadCommand>(
    command: C,
    args: CommandArgs<C>,
  ): Promise<CommandResult<C>> {
    try {
      return await this.#ipc.call(command, args)
    } catch (error) {
      throw toAppError(error)
    }
  }
}

/**
 * A {@link DatabaseService} over the `db_query` command.
 */
export function createDatabaseService(deps: DatabaseServiceDeps): DatabaseService {
  return new DatabaseServiceImpl(deps)
}
