import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  AppError,
  type BackupService,
  type BackupState,
  type DuplicateIdGroup,
  type GraphSessionService,
  type IcloudStatus,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestICloudNativeService,
  createTestPlatformService,
  createTestBackupService,
  type TestOpenGraph,
  type TestPlatformOptions,
  type TestBackupService,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SyncSection } from './sync-section.tsx'

const ICLOUD_DOCUMENTS = '/Users/alex/Library/Mobile Documents/iCloud~app/Documents'
const ICLOUD_GRAPH: TestOpenGraph = { root: `${ICLOUD_DOCUMENTS}/Notes`, name: 'Notes' }

// What the app's fakes answer; each test sets them before `renderSection`.
let icloud: {
  status: IcloudStatus
  pendingNotes: number
  /**
   * The native copy of a graph move rejects, though iCloud reports available.
   */
  copyFails: boolean
}
let duplicateIds: DuplicateIdGroup[]
let graph: TestOpenGraph
let platform: TestPlatformOptions
let backupState: BackupState

// The services of the app under test.
let backup: TestBackupService
let disconnectGraph: MockInstance<BackupService['disconnectGraph']>
let openRecent: MockInstance<GraphSessionService['openRecent']>
// What the next `openRecent` of the rendered app resolves.
let reopens: boolean

async function renderSection(): Promise<void> {
  const icloudNative = createTestICloudNativeService({
    status: icloud.status,
    pendingCount: icloud.pendingNotes,
  })
  if (icloud.copyFails) {
    vi.spyOn(icloudNative, 'adoptGraph').mockRejectedValue(
      new AppError('io', 'test iCloud: the container is unavailable'),
    )
  }
  backup.setState(backupState)
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    icloudNative,
    backup,
    platform: createTestPlatformService(platform),
  })
  vi.spyOn(app.indexQuery, 'getDuplicateNoteIds').mockImplementation(() => {
    return Promise.resolve(duplicateIds)
  })
  openRecent = vi
    .spyOn(app.graphSession, 'openRecent')
    .mockImplementation(() => Promise.resolve(reopens))
  await renderInApp(<SyncSection />, { app, graph, route: { kind: 'settings' } })
}

function legend(section: Locator, text: string): Locator {
  return section.locate('legend').filter({ hasText: text })
}

beforeEach(() => {
  platform = {}
  graph = { root: '/Users/alex/Documents/Notes', name: 'Notes' }
  icloud = {
    status: {
      available: true,
      documentsRoot: ICLOUD_DOCUMENTS,
      existingGraphRoots: [`${ICLOUD_DOCUMENTS}/Personal`],
    },
    pendingNotes: 0,
    copyFails: false,
  }
  duplicateIds = []
  backupState = { phase: 'disconnected' }
  reopens = true
  backup = createTestBackupService()
  disconnectGraph = vi.spyOn(backup, 'disconnectGraph')
})

describe('SyncSection', () => {
  it('combines iCloud Drive and GitHub sync under Sync for local graphs', async () => {
    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect.element(legend(section, 'iCloud Drive')).toBeInTheDocument()
    await expect.element(section.getByText('1 graph in iCloud Drive.')).toBeInTheDocument()
    await expect.element(legend(section, 'GitHub sync')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: /connect github/i }))
      .toBeInTheDocument()
  })

  it('keeps GitHub sync visible when the graph syncs through iCloud', async () => {
    graph = ICLOUD_GRAPH

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect.element(legend(section, 'iCloud Drive')).toBeInTheDocument()
    await expect.element(section.getByText('All note files are downloaded.')).toBeInTheDocument()
    await expect.element(section.getByText('No sync forks.')).toBeInTheDocument()
    await expect.element(legend(section, 'GitHub sync')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: /connect github/i }))
      .toBeInTheDocument()
  })

  it('surfaces iCloud download and fork counts', async () => {
    graph = ICLOUD_GRAPH
    icloud.pendingNotes = 2
    duplicateIds = [{ id: 'note-1', paths: ['notes/a.md', 'notes/a 2.md'] }]

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect
      .element(section.getByText('2 notes are still downloading from iCloud.'))
      .toBeInTheDocument()
    await expect.element(section.getByText('1 sync fork')).toBeInTheDocument()
  })
})

describe('moving a graph to iCloud', () => {
  const NEW_ROOT = `${ICLOUD_DOCUMENTS}/Notes`

  /**
   * Confirm the move dialog; `copyFails` makes the native copy reject.
   */
  async function confirmMove(options?: { copyFails?: boolean }): Promise<Locator> {
    icloud.copyFails = options?.copyFails === true
    await renderSection()
    const section = page.getByRole('region', { name: 'Sync' })
    await section.getByRole('button', { name: 'Move graph to iCloud…' }).click()
    await page.getByRole('button', { name: 'Move to iCloud' }).click()
    return section
  }

  it('copies the graph, disconnects the backup, and reopens it in iCloud', async () => {
    backupState = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    }

    await confirmMove()

    await vi.waitFor(() => expect(openRecent).toHaveBeenCalledWith(NEW_ROOT))
    expect(disconnectGraph).toHaveBeenCalledOnce()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves a disconnected backup alone', async () => {
    await confirmMove()

    await vi.waitFor(() => expect(openRecent).toHaveBeenCalledWith(NEW_ROOT))
    expect(disconnectGraph).not.toHaveBeenCalled()
  })

  it('reports a backup that could not be disconnected and a graph that did not reopen', async () => {
    backupState = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    }
    disconnectGraph.mockRejectedValueOnce(new AppError('io', 'remote locked'))
    reopens = false

    const section = await confirmMove()

    await expect
      .element(
        section.getByText(
          'The graph moved to iCloud, but GitHub sync could not be disconnected from the original folder: remote locked The copy landed in iCloud but could not be opened — open it from Saved graphs.',
        ),
      )
      .toBeInTheDocument()
  })

  it('keeps the dialog open and reports a copy that failed', async () => {
    await confirmMove({ copyFails: true })

    await expect
      .element(page.getByText('test iCloud: the container is unavailable'))
      .toBeInTheDocument()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
    expect(openRecent).not.toHaveBeenCalled()
  })
})

describe('SyncSection off macOS desktop', () => {
  it('keeps backup visible when the iCloud row is platform-hidden', async () => {
    platform = { isMacosDesktop: false }
    graph = ICLOUD_GRAPH
    icloud.status = { ...icloud.status, existingGraphRoots: [] }
    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    expect(legend(section, 'iCloud Drive').query()).toBeNull()
    await expect.element(legend(section, 'GitHub sync')).toBeInTheDocument()
  })
})
