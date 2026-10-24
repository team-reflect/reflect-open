import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  AppError,
  type GitSyncService,
  type GitSyncState,
  type GraphSessionService,
  type IcloudStatus,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestICloudNativeService,
  createTestPlatformService,
  createTestGitSyncService,
  type TestOpenGraph,
  type TestPlatformOptions,
  type TestGitSyncService,
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
let graph: TestOpenGraph
let platform: TestPlatformOptions
let gitSyncState: GitSyncState

// The services of the app under test.
let gitSync: TestGitSyncService
let disconnectGraph: MockInstance<GitSyncService['disconnectGraph']>
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
  gitSync.setState(gitSyncState)
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    icloudNative,
    gitSync,
    platform: createTestPlatformService(platform),
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
  gitSyncState = { phase: 'disconnected' }
  reopens = true
  gitSync = createTestGitSyncService()
  disconnectGraph = vi.spyOn(gitSync, 'disconnectGraph')
})

describe('SyncSection', () => {
  it('combines iCloud Drive and a Git repository under Sync', async () => {
    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect.element(legend(section, 'iCloud Drive')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: 'Move graph to iCloud…' }))
      .toBeInTheDocument()
    await expect.element(legend(section, 'Git repository')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: 'Connect a repository…' }))
      .toBeInTheDocument()
    expect(legend(section, 'GitHub').query()).toBeNull()
  })

  it('keeps the Git repository visible when the graph syncs through iCloud', async () => {
    graph = ICLOUD_GRAPH

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect.element(legend(section, 'iCloud Drive')).toBeInTheDocument()
    await expect.element(section.getByText(/This graph lives in iCloud Drive/)).toBeInTheDocument()
    await expect.element(legend(section, 'Git repository')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: 'Connect a repository…' }))
      .toBeInTheDocument()
  })

  it('surfaces the iCloud download count', async () => {
    graph = ICLOUD_GRAPH
    icloud.pendingNotes = 2

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect
      .element(section.getByText('2 notes are still downloading from iCloud.'))
      .toBeInTheDocument()
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
    gitSyncState = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
      isPrimaryChannel: true,
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
    gitSyncState = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
      isPrimaryChannel: true,
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
    await expect.element(legend(section, 'Git repository')).toBeInTheDocument()
  })
})
