import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestICloudNativeService } from '../testing/sync.ts'
import { createICloudMigrationService } from './icloud-migration-service.ts'

const DISCONNECT_FAILURE =
  'The graph moved to iCloud, but GitHub sync could not be disconnected from the original folder: remote locked'
const OPEN_FAILURE =
  'The copy landed in iCloud but could not be opened — open it from Saved graphs.'

function setup(options?: { available?: boolean }) {
  const icloudNative = createTestICloudNativeService({
    status: { available: options?.available ?? true, documentsRoot: '/iCloud/Documents' },
  })
  const graphSession = createTestGraphSessionService({ graph: { generation: 4 } })
  const migration = createICloudMigrationService({ icloudNative, graphSession })
  const steps: string[] = []
  const openGraph = vi.fn((root: string) => {
    steps.push(`open ${root}`)
    return true
  })
  const disconnectGitSync = vi.fn(() => {
    steps.push('disconnect')
  })
  const onCopied = vi.fn((failure: string | null) => {
    steps.push(`copied ${String(failure)}`)
  })
  return { icloudNative, graphSession, migration, steps, openGraph, disconnectGitSync, onCopied }
}

describe('createICloudMigrationService', () => {
  it('copies, disconnects the backup, then reopens the graph at its new root', async () => {
    const { icloudNative, migration, steps, openGraph, disconnectGitSync, onCopied } = setup()

    await expect(
      migration.moveGraph({ disconnectGitSync, openGraph, onCopied }),
    ).resolves.toBeNull()

    expect(icloudNative.calls()).toEqual([{ method: 'adoptGraph', args: [4] }])
    expect(steps).toEqual(['disconnect', 'copied null', 'open /iCloud/Documents/Notes'])
  })

  it('skips the backup step when no backup is connected', async () => {
    const { migration, steps, openGraph, onCopied } = setup()

    await expect(
      migration.moveGraph({ disconnectGitSync: null, openGraph, onCopied }),
    ).resolves.toBeNull()

    expect(steps).toEqual(['copied null', 'open /iCloud/Documents/Notes'])
  })

  it('a failed copy changes nothing: the backup stays connected and the graph stays open', async () => {
    const { migration, openGraph, disconnectGitSync, onCopied } = setup({ available: false })

    await expect(migration.moveGraph({ disconnectGitSync, openGraph, onCopied })).resolves.toBe(
      'test iCloud: the container is unavailable',
    )

    expect(disconnectGitSync).not.toHaveBeenCalled()
    expect(onCopied).not.toHaveBeenCalled()
    expect(openGraph).not.toHaveBeenCalled()
  })

  it('a failed disconnect is reported before the reopen and does not block it', async () => {
    const { migration, openGraph, onCopied } = setup()

    await expect(
      migration.moveGraph({
        disconnectGitSync: () => Promise.reject(new AppError('io', 'remote locked')),
        openGraph,
        onCopied,
      }),
    ).resolves.toBe(DISCONNECT_FAILURE)

    expect(onCopied).toHaveBeenCalledWith(DISCONNECT_FAILURE)
    expect(openGraph).toHaveBeenCalledWith('/iCloud/Documents/Notes')
  })

  it('a graph that does not reopen is reported alongside a disconnect failure', async () => {
    const { migration, onCopied } = setup()

    await expect(
      migration.moveGraph({
        disconnectGitSync: () => Promise.reject(new AppError('io', 'remote locked')),
        openGraph: () => false,
        onCopied,
      }),
    ).resolves.toBe(`${DISCONNECT_FAILURE} ${OPEN_FAILURE}`)

    await expect(
      migration.moveGraph({ disconnectGitSync: null, openGraph: () => false }),
    ).resolves.toBe(OPEN_FAILURE)
  })

  it('reports a missing graph without copying', async () => {
    const { icloudNative, graphSession, migration, openGraph } = setup()
    graphSession.setGraph(null)

    await expect(migration.moveGraph({ disconnectGitSync: null, openGraph })).resolves.toBe(
      'No graph is open.',
    )
    expect(icloudNative.calls()).toEqual([])
  })

  it('a reopen that throws replaces the failure text', async () => {
    const { migration } = setup()

    await expect(
      migration.moveGraph({
        disconnectGitSync: () => Promise.reject(new AppError('io', 'remote locked')),
        openGraph: () => Promise.reject(new AppError('io', 'graph vanished')),
      }),
    ).resolves.toBe('graph vanished')
  })
})
