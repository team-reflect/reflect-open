import { invoke } from '@tauri-apps/api/core'
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'

/**
 * A Kysely dialect that executes against the SQLite index living in the Rust
 * process (Plan 04). Kysely compiles a query to `{ sql, parameters }`; we ship it
 * over the `db_query` Tauri command and Rust returns the rows. Writes do **not**
 * go through here — they use the `index_*` commands, which run their own Rust
 * transactions — so this is a read-only bridge and transactions are unsupported.
 */
class IpcConnection implements DatabaseConnection {
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const rows = await invoke<R[]>('db_query', {
      sql: compiled.sql,
      params: compiled.parameters as unknown[],
    })
    // Index reads are our own projection (Rust serializes from a known schema),
    // so per Plan 04 §2 we deliberately don't zod-parse every row (real overhead
    // on large FTS scans). A cheap O(1) shape check still fails fast on a
    // malformed payload at the boundary rather than deep in a query consumer.
    if (!Array.isArray(rows)) {
      throw new Error('db_query did not return a row array')
    }
    return { rows }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported over the IPC SQLite bridge')
  }
}

const SHARED_CONNECTION = new IpcConnection()

class IpcDriver implements Driver {
  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return SHARED_CONNECTION
  }

  async beginTransaction(): Promise<void> {
    throw new Error('transactions run in Rust (index_* commands), not via Kysely')
  }

  async commitTransaction(): Promise<void> {
    throw new Error('transactions run in Rust (index_* commands), not via Kysely')
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error('transactions run in Rust (index_* commands), not via Kysely')
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/** The read-only, IPC-backed SQLite dialect for the local index. */
export class IpcDialect implements Dialect {
  createAdapter(): SqliteAdapter {
    return new SqliteAdapter()
  }

  createDriver(): Driver {
    return new IpcDriver()
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler()
  }

  createIntrospector(db: Kysely<unknown>): SqliteIntrospector {
    return new SqliteIntrospector(db)
  }
}
