import { createNodeTestDatabaseService, type TestDatabaseService } from '@reflect/core/testing'

/**
 * The test database of browser tests: the index of the native shells,
 * compiled to wasm, with a new in-memory database.
 */
export function createWasmTestDatabaseService(): TestDatabaseService {
  return createNodeTestDatabaseService()
}
