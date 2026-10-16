import { describe, expect, it, vi } from 'vitest'
import { createIpcBridgeService } from '../ipc/ipc-service.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import {
  createFileChangeService,
  type FileChange,
  type FileChangeBatch,
} from './file-change-service.ts'

function setup(echoOwnWrites = false) {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const fileChanges = createFileChangeService({ ipc, logger, echoOwnWrites })
  return { ipc, logger, fileChanges }
}

/**
 * Let `listenNow` finish registering.
 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createFileChangeService', () => {
  it('delivers watcher events and emitted batches with their source', async () => {
    const { ipc, fileChanges } = setup()
    const seen: FileChangeBatch[] = []
    const unlisten = fileChanges.subscribe((batch) => {
      seen.push(batch)
    })
    await settle()

    ipc.emit('index:changed', [{ path: 'notes/watched.md', kind: 'upsert', modifiedMs: 1 }])
    fileChanges.emit({ changes: [{ path: 'notes/pulled.md', kind: 'upsert' }], source: 'pull' })
    unlisten()
    ipc.emit('index:changed', [{ path: 'notes/late.md', kind: 'remove' }])
    fileChanges.emit({ changes: [{ path: 'notes/late.md', kind: 'remove' }], source: 'pull' })

    expect(seen).toEqual([
      {
        changes: [{ path: 'notes/watched.md', kind: 'upsert', modifiedMs: 1 }],
        source: 'external',
      },
      { changes: [{ path: 'notes/pulled.md', kind: 'upsert' }], source: 'pull' },
    ])
  })

  it('subscribes synchronously, before the native listener registers', () => {
    const { fileChanges } = setup()
    const listener = vi.fn()
    fileChanges.subscribe(listener)

    fileChanges.emit({ changes: [{ path: 'notes/a.md', kind: 'upsert' }], source: 'external' })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('drops a malformed watcher payload with an error', async () => {
    const { ipc, logger, fileChanges } = setup()
    const listener = vi.fn()
    fileChanges.subscribe(listener)
    await settle()

    ipc.emit('index:changed', { not: 'an array' })

    expect(listener).not.toHaveBeenCalled()
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid index:changed payload:',
    ])
  })

  it('keeps no listener and does not throw when the transport cannot listen', async () => {
    const logger = createTestLoggerService()
    const ipc = createIpcBridgeService({
      transport: {
        invoke: async () => null,
        listen: async () => {
          throw new Error('no transport')
        },
      },
      logger,
    })
    const fileChanges = createFileChangeService({ ipc, logger, echoOwnWrites: false })
    const listener = vi.fn()
    const reconcile = vi.fn()

    const unlisten = fileChanges.subscribe(listener)
    const unlistenReconcile = fileChanges.subscribeReconcile(reconcile)
    await settle()
    unlisten()
    unlistenReconcile()
    fileChanges.emit({ changes: [{ path: 'notes/a.md', kind: 'upsert' }], source: 'external' })

    expect(listener).not.toHaveBeenCalled()
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      'failed to listen for "index:changed"',
      'failed to listen for "index:reconcile"',
    ])
  })

  it('detaches a native listener that registers after unlisten', async () => {
    const { ipc, fileChanges } = setup()
    const listener = vi.fn()
    fileChanges.subscribe(listener)()
    await settle()

    ipc.emit('index:changed', [{ path: 'notes/a.md', kind: 'upsert' }])

    expect(listener).not.toHaveBeenCalled()
  })

  it('forwards reconcile requests until unlisten', async () => {
    const { ipc, fileChanges } = setup()
    const listener = vi.fn()
    const unlisten = fileChanges.subscribeReconcile(listener)
    await settle()

    ipc.emit('index:reconcile', null)
    unlisten()
    ipc.emit('index:reconcile', null)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps own writes off the change stream when echo is off', () => {
    const { fileChanges } = setup(false)
    const changes = vi.fn()
    fileChanges.subscribe(changes)

    fileChanges.reportOwnWrite([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1 }])

    expect(changes).not.toHaveBeenCalled()
  })

  it('echoes own writes onto the change stream when echo is on', () => {
    const { fileChanges } = setup(true)
    const seen: FileChangeBatch[] = []
    fileChanges.subscribe((batch) => {
      seen.push(batch)
    })

    fileChanges.reportOwnWrite([{ path: 'notes/gone.md', kind: 'remove' }])

    expect(seen).toEqual([
      { changes: [{ path: 'notes/gone.md', kind: 'remove' }], source: 'own-write' },
    ])
  })

  it('shares one native listener across subscribers and parses each payload once', async () => {
    const { ipc, fileChanges } = setup()
    const listen = vi.spyOn(ipc, 'listen')
    const first: FileChangeBatch[] = []
    const second: FileChangeBatch[] = []
    const unlistenFirst = fileChanges.subscribe((batch) => {
      first.push(batch)
    })
    const unlistenSecond = fileChanges.subscribe((batch) => {
      second.push(batch)
    })
    await settle()

    ipc.emit('index:changed', [{ path: 'notes/a.md', kind: 'upsert' }])

    expect(listen).toHaveBeenCalledTimes(1)
    expect(first).toHaveLength(1)
    expect(second[0]).toBe(first[0])
    unlistenFirst()
    unlistenSecond()
  })

  it('tears down the native listener after the last unsubscribe and re-registers on the next', async () => {
    const { ipc, fileChanges } = setup()
    const listen = vi.spyOn(ipc, 'listen')
    const paths: string[] = []
    const listener = (batch: FileChangeBatch): void => {
      paths.push(...batch.changes.map((change) => change.path))
    }
    const unlistenFirst = fileChanges.subscribe(listener)
    const unlistenSecond = fileChanges.subscribe(listener)
    await settle()

    unlistenFirst()
    ipc.emit('index:changed', [{ path: 'notes/a.md', kind: 'upsert' }])
    unlistenSecond()
    ipc.emit('index:changed', [{ path: 'notes/b.md', kind: 'upsert' }])
    const unlistenThird = fileChanges.subscribe(listener)
    await settle()
    ipc.emit('index:changed', [{ path: 'notes/c.md', kind: 'upsert' }])

    expect(listen).toHaveBeenCalledTimes(2)
    expect(paths).toEqual(['notes/a.md', 'notes/c.md'])
    unlistenThird()
  })

  it('starts and stops the native watcher', async () => {
    const { ipc, fileChanges } = setup()
    ipc.onCommand('watch_start', () => null)
    ipc.onCommand('watch_stop', () => null)

    await fileChanges.startWatcher()
    await fileChanges.stopWatcher()

    expect(ipc.calls()).toEqual([
      { command: 'watch_start', args: {} },
      { command: 'watch_stop', args: {} },
    ])
  })
})

describe('FileChangeService.subscribe', () => {
  it('delivers locally emitted batches (sync merges) like watcher events', async () => {
    const { fileChanges } = setup()
    const received: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      received.push(changes)
    })

    const changes: FileChange[] = [
      { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
      { path: 'notes/gone.md', kind: 'remove' },
    ]
    fileChanges.emit({ changes: changes, source: 'external' })

    expect(received).toEqual([changes])
    unlisten()
  })

  it('stops local delivery after unlisten', async () => {
    const { fileChanges } = setup()
    const received: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      received.push(changes)
    })
    unlisten()

    fileChanges.emit({ changes: [{ path: 'notes/a.md', kind: 'upsert' }], source: 'external' })

    expect(received).toEqual([])
  })

  it('delivers both bridge and local batches to the same subscriber', async () => {
    const { ipc, fileChanges } = setup()
    const received: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      received.push(changes)
    })
    await Promise.resolve()

    ipc.emit('index:changed', [{ path: 'notes/watched.md', kind: 'upsert' }])
    fileChanges.emit({ changes: [{ path: 'notes/merged.md', kind: 'upsert' }], source: 'external' })

    expect(received.map((batch) => batch[0]!.path)).toEqual(['notes/watched.md', 'notes/merged.md'])
    unlisten()
  })
})
