import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService, createTestCoreServices } from '@reflect/core/testing'
import { createAppServices } from './create-app-services.ts'
import { createTestAppHost, createTestUpdaterAdapter } from './testing/index.ts'

describe('createAppServices', () => {
  it('supports updates only with an updater adapter', () => {
    const core = createTestCoreServices({ database: createNodeTestDatabaseService() })
    expect(createAppServices(core, createTestAppHost()).update.supported).toBe(false)
    const app = createAppServices(core, createTestAppHost({ updater: createTestUpdaterAdapter() }))
    expect(app.update.supported).toBe(true)
    core.database.close()
  })
})
