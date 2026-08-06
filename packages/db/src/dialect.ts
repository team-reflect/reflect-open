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
 * Executes one compiled read-only query against the SQLite index and resolves
 * with the raw row array. The host supplies this — the desktop app ships the
 * query over the `db_query` IPC command to Rust; tests supply an in-memory
 * fake. Keeping the transport injected keeps this package platform-agnostic.
 */
export type QueryRunner = (sql: string, params: readonly unknown[]) => Promise<unknown>

/**
 * A Kysely dialect that executes against the SQLite index living in the Rust
 * process (Plan 04). Kysely compiles a query to `{ sql, parameters }`; the
 * injected {@link QueryRunner} executes it and returns the rows. Writes do
 * **not** go through here — they use the `index_*` commands, which run their
 * own Rust transactions — so this is a read-only bridge and transactions are
 * unsupported.
 */
class IpcConnection implements DatabaseConnection {
  constructor(private readonly runQuery: QueryRunner) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const rows = await this.runQuery(compiled.sql, compiled.parameters)
    // Index reads are our own projection (Rust serializes from a known schema),
    // so per Plan 04 §2 we deliberately don't zod-parse every row (real overhead
    // on large FTS scans). A cheap O(1) shape check still fails fast on a
    // malformed payload at the boundary rather than deep in a query consumer.
    if (!Array.isArray(rows)) {
      throw new TypeError('db_query did not return a row array')
    }
    return { rows: rows as R[] }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported over the IPC SQLite bridge')
  }
}

class IpcDriver implements Driver {
  constructor(private readonly connection: IpcConnection) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection
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

/** The read-only SQLite dialect for the local index, over an injected runner. */
export class IpcDialect implements Dialect {
  private readonly connection: IpcConnection

  constructor(runQuery: QueryRunner) {
    this.connection = new IpcConnection(runQuery)
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter()
  }

  createDriver(): Driver {
    return new IpcDriver(this.connection)
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler()
  }

  createIntrospector(db: Kysely<unknown>): SqliteIntrospector {
    return new SqliteIntrospector(db)
  }
}
