import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestIpcBridgeService } from '../testing/index.ts'
import { createDatabaseService } from './database-service.ts'

describe('createDatabaseService', () => {
  it('sends a read as its command and returns the result', async () => {
    const ipc = createTestIpcBridgeService({ commands: { index_meta_get: () => 'v' } })
    const database = createDatabaseService({ ipc })

    await expect(database.read('index_meta_get', { key: 'k' })).resolves.toBe('v')
    expect(ipc.calls()).toEqual([{ command: 'index_meta_get', args: { key: 'k' } }])
  })

  it('rejects a failed read with its app error', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        index_meta_get: () => {
          throw new AppError('io', 'index locked')
        },
      },
    })
    const database = createDatabaseService({ ipc })

    await expect(database.read('index_meta_get', { key: 'k' })).rejects.toEqual(
      new AppError('io', 'index locked'),
    )
  })
})
