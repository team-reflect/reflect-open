import { createDb } from '@reflect/db'
import { toAppError } from '@reflect/core'
import type { TestDatabaseQuery, TestDatabaseService } from '@reflect/core/testing'
import { createDevIndexDb } from '@/dev/dev-index-db.ts'

/**
 * The browser twin of `createTestDatabaseService()` from
 * `@reflect/core/testing`: the same real migrations over the dev bridge's wasm
 * SQLite, which only loads under this app's Vite config. Browser tests get it
 * from `createTestDatabaseService()` already, opened on the first query (see
 * `setup-browser.ts`); call this only when a test needs the database open
 * before its first query.
 */
export async function createWasmTestDatabaseService(): Promise<TestDatabaseService> {
  const index = await createDevIndexDb()
  let closed = false
  const queries: TestDatabaseQuery[] = []

  const runQuery = (sql: string, params: readonly unknown[]): Promise<unknown> =>
    Promise.try(() => {
      queries.push({ sql, params: [...params] })
      try {
        if (closed) {
          throw new Error('the test database is closed')
        }
        return index.query(sql, params)
      } catch (error) {
        throw toAppError(error)
      }
    })

  return {
    db: createDb(runQuery),
    runQuery,
    applyProjection(note) {
      if (closed) {
        throw new Error('the test database is closed')
      }
      index.applyNote(note)
    },
    getQueries() {
      return [...queries]
    },
    close() {
      if (!closed) {
        closed = true
        index.close()
      }
    },
  }
}
