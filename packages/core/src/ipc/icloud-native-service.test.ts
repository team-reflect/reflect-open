import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createICloudNativeService } from './icloud-native-service.ts'

function serviceOver(commands?: Record<string, (args: Record<string, unknown>) => unknown>) {
  const ipc = createTestIpcBridgeService({ commands })
  const logger = createTestLoggerService()
  const icloud = createICloudNativeService({ ipc, logger })
  return { icloud, ipc, logger }
}

const SWEEP = { changed: [], copies: [], autoResolved: 0 }

describe('createICloudNativeService', () => {
  it('sends each command with its arguments', async () => {
    const { icloud, ipc } = serviceOver({
      icloud_status: () => ({ available: true, documentsRoot: '/c', existingGraphRoots: [] }),
      icloud_adopt_graph: () => '/c/Notes',
      icloud_conflicts_scan: () => SWEEP,
      icloud_watch_start: () => null,
      icloud_watch_stop: () => null,
      icloud_download_pending: () => 4,
      icloud_pending_count: () => 2,
      icloud_request_downloads: (args) => (args.paths as string[]).length,
    })

    await expect(icloud.status()).resolves.toMatchObject({ available: true })
    await expect(icloud.adoptGraph(5)).resolves.toBe('/c/Notes')
    await expect(icloud.conflictsScan({ generation: 5, scope: 'candidates' })).resolves.toEqual(
      SWEEP,
    )
    await icloud.watchStart('/c/Notes')
    await icloud.watchStop()
    await expect(icloud.downloadPending('/c/Notes', 'notes')).resolves.toBe(4)
    await expect(icloud.pendingCount('/c/Notes', 'all')).resolves.toBe(2)
    await expect(icloud.requestDownloads(['notes/a.md'])).resolves.toBe(1)

    expect(ipc.calls()).toEqual([
      { command: 'icloud_status', args: {} },
      { command: 'icloud_adopt_graph', args: { generation: 5 } },
      {
        command: 'icloud_conflicts_scan',
        args: {
          generation: 5,
          skipPaths: [],
          ingestedPaths: [],
          recordBaseline: false,
          scope: 'candidates',
        },
      },
      { command: 'icloud_watch_start', args: { root: '/c/Notes' } },
      { command: 'icloud_watch_stop', args: {} },
      { command: 'icloud_download_pending', args: { root: '/c/Notes', notesOnly: true } },
      { command: 'icloud_pending_count', args: { root: '/c/Notes', notesOnly: false } },
      { command: 'icloud_request_downloads', args: { paths: ['notes/a.md'] } },
    ])
  })

  it('skips the command for an empty download request', async () => {
    const { icloud, ipc } = serviceOver()

    await expect(icloud.requestDownloads([])).resolves.toBe(0)
    expect(ipc.calls()).toEqual([])
  })

  it('delivers conflict paths and drops a malformed payload with an error', async () => {
    const { icloud, ipc, logger } = serviceOver()
    const received: string[][] = []
    const unlisten = icloud.subscribeConflicts((paths) => {
      received.push(paths)
    })
    await Promise.resolve()

    ipc.emit('icloud:conflicts', ['notes/a.md'])
    ipc.emit('icloud:conflicts', 'notes/b.md')
    unlisten()
    ipc.emit('icloud:conflicts', ['notes/c.md'])

    expect(received).toEqual([['notes/a.md']])
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('delivers watch failures until unsubscribed', async () => {
    const { icloud, ipc } = serviceOver()
    let failures = 0
    const unlisten = icloud.subscribeWatchFailed(() => {
      failures += 1
    })
    await Promise.resolve()

    ipc.emit('icloud:watch-failed', null)
    unlisten()
    ipc.emit('icloud:watch-failed', null)

    expect(failures).toBe(1)
  })

  it('logs a failed event registration', async () => {
    const ipc = createTestIpcBridgeService()
    const logger = createTestLoggerService()
    vi.spyOn(ipc, 'listen').mockRejectedValue(new Error('no events'))
    const icloud = createICloudNativeService({ ipc, logger })

    icloud.subscribeWatchFailed(() => {})

    await expect.poll(() => logger.getErrors()).toHaveLength(1)
  })
})
