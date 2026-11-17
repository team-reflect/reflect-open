import type { IndexReadCommand } from '@reflect/types'
import { toAppError } from '../errors.ts'
import type { CommandArgs, CommandResult, IpcBridgeService } from '../ipc/ipc-service.ts'

export interface DatabaseServiceDeps {
  readonly ipc: IpcBridgeService
}

/**
 * Reads of the active graph's SQLite index. Each read is a typed command
 * whose SQL runs in Rust. Writes go through the `index_*` commands, which run
 * their own Rust transactions.
 */
export interface DatabaseService {
  /**
   * Run one read command of the index and resolve with its typed result. A
   * rejection is an `AppError`.
   */
  read<C extends IndexReadCommand>(command: C, args: CommandArgs<C>): Promise<CommandResult<C>>
}

class DatabaseServiceImpl implements DatabaseService {
  readonly #ipc: IpcBridgeService

  constructor(deps: DatabaseServiceDeps) {
    this.#ipc = deps.ipc
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
 * A {@link DatabaseService} over the index read commands.
 */
export function createDatabaseService(deps: DatabaseServiceDeps): DatabaseService {
  return new DatabaseServiceImpl(deps)
}
