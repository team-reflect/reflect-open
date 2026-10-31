import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestIpcBridgeService } from '../testing/index.ts'

import { createSecretStoreService } from './secret-store-service.ts'
describe('createSecretStoreService', () => {
  it('reads, writes and deletes through the secret commands', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        secret_get: () => 'value',
        secret_set: () => null,
        secret_delete: () => null,
      },
    })
    const store = createSecretStoreService({ ipc })

    await expect(store.get('a')).resolves.toBe('value')
    await store.set('a', 'b')
    await store.delete('a')

    expect(ipc.calls()).toEqual([
      { command: 'secret_get', args: { name: 'a' } },
      { command: 'secret_set', args: { name: 'a', value: 'b' } },
      { command: 'secret_delete', args: { name: 'a' } },
    ])
  })

  it('reads a missing secret as null', async () => {
    const ipc = createTestIpcBridgeService({ commands: { secret_get: () => null } })
    await expect(createSecretStoreService({ ipc }).get('a')).resolves.toBeNull()
  })

  it('rejects a malformed response with a parse error', async () => {
    const ipc = createTestIpcBridgeService({ commands: { secret_get: () => 42 } })
    await expect(createSecretStoreService({ ipc }).get('a')).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('rejects a failed command with its app error', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        secret_set: () => {
          throw new AppError('io', 'keychain locked')
        },
      },
    })
    await expect(createSecretStoreService({ ipc }).set('a', 'b')).rejects.toEqual(
      new AppError('io', 'keychain locked'),
    )
  })
})
