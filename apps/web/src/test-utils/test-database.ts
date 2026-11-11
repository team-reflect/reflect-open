import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { createDb } from '@reflect/db'
import { toAppError } from '@reflect/core'
import type { TestDatabaseQuery, TestDatabaseService } from '@reflect/core/testing'
import { openDevIndexDb } from '@/dev/dev-index-db.ts'

// Loaded once per page; each test database is a new in-memory database over it.
const sqlite3 = await sqlite3InitModule()

/**
 * The browser twin of `createNodeTestDatabaseService()` from
 * `@reflect/core/testing`: the same real migrations over the dev bridge's wasm
 * SQLite, which only loads under this app's Vite config.
 */
export function createWasmTestDatabaseService(): TestDatabaseService {
  const index = openDevIndexDb(sqlite3)
  let closed = false
  const queries: TestDatabaseQuery[] = []

  const runQuery = (sql: string, params: readonly unknown[]): Promise<unknown> => {
    return Promise.try(() => {
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
  }

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
