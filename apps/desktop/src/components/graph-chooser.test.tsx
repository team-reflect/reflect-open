import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import type { BuildPlatform, GraphSessionService, IcloudStatus, Settings } from '@reflect/core'
import {
  createTestCoreServices,
  createTestGraphSessionService,
  createTestICloudNativeService,
  createTestPlatformService,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { GraphChooser } from './graph-chooser.tsx'

const RECENTS = [
  { root: '/graphs/work', name: 'work', openedMs: 2 },
  { root: '/graphs/personal', name: 'personal', openedMs: 1 },
]

// The spies of the rendered app; set by `renderChooser`.
let openRecent: MockInstance<GraphSessionService['openRecent']>
let createGraphAt: MockInstance<GraphSessionService['createGraphAt']>
let forgetRecent: MockInstance<GraphSessionService['forgetRecent']>

async function renderChooser(options?: {
  icloud?: Partial<IcloudStatus>
  settings?: Partial<Settings>
  buildPlatform?: BuildPlatform
}): Promise<void> {
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ buildPlatform: options?.buildPlatform ?? 'darwin' }),
    graphSession: createTestGraphSessionService({ recents: RECENTS }),
    icloudNative: createTestICloudNativeService(
      options?.icloud === undefined ? undefined : { status: options.icloud },
    ),
  })
  openRecent = vi.spyOn(core.graphSession, 'openRecent').mockResolvedValue(true)
  createGraphAt = vi.spyOn(core.graphSession, 'createGraphAt').mockResolvedValue(true)
  // Calls through: the real service forgets the graph and refreshes the list.
  forgetRecent = vi.spyOn(core.graphSession, 'forgetRecent')
  await renderInApp(<GraphChooser />, {
    core,
    graph: null,
    route: null,
    ...(options?.settings === undefined ? {} : { settings: options.settings }),
  })
}

describe('GraphChooser', () => {
  it('leads with iCloud (recommended) beside the pick-a-folder path', async () => {
    await renderChooser({
      icloud: {
        available: true,
        documentsRoot: '/icloud/Documents',
        existingGraphRoots: [],
      },
    })

    await expect.element(page.getByRole('heading', { name: 'iCloud' })).toBeVisible()
    await expect.element(page.getByText('Recommended')).toBeVisible()
    await expect.element(page.getByText(/Open an existing folder/)).toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'A folder you choose' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Choose a folder/ })).toBeVisible()
    await expect.element(page.getByText(/Reflect keeps its files where they are/)).toBeVisible()
  })

  it('creates an iCloud graph from the typed name', async () => {
    await renderChooser({
      icloud: {
        available: true,
        documentsRoot: '/icloud/Documents',
        existingGraphRoots: [],
      },
    })

    const nameInput = page.getByRole('textbox', { name: 'Name' })
    // The input starts disabled until `icloud_status` resolves; typing into it
    // before then throws on slower engines (WebKit).
    await expect.element(nameInput).toBeEnabled()
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'My Notes')
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await vi.waitFor(() => expect(createGraphAt).toHaveBeenCalledWith('/icloud/Documents/My Notes'))
  })

  it('lists every graph already in the container and opens the clicked one', async () => {
    await renderChooser({
      icloud: {
        available: true,
        documentsRoot: '/icloud/Documents',
        existingGraphRoots: ['/icloud/Documents/Notes', '/icloud/Documents/Work'],
      },
    })

    await expect.element(page.getByRole('button', { name: 'Notes' })).toBeVisible()
    await expect.element(page.getByText('Open an existing graph from iCloud Drive.')).toBeVisible()
    await expect.element(page.getByText('or create new graph')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Work', exact: true }))

    await vi.waitFor(() => expect(openRecent).toHaveBeenCalledWith('/icloud/Documents/Work'))
  })

  it('creates a new graph alongside existing ones, refusing taken names', async () => {
    await renderChooser({
      icloud: {
        available: true,
        documentsRoot: '/icloud/Documents',
        existingGraphRoots: ['/icloud/Documents/Notes'],
      },
    })

    // Wait for the status to land (the existing graph is listed) so the
    // compact create row — not the pre-status empty-container form — is the
    // input under test. Next to an existing list the row starts empty.
    await expect.element(page.getByRole('button', { name: 'Notes' })).toBeVisible()
    const nameInput = page.getByRole('textbox', { name: 'Name' })
    await expect.element(nameInput).toHaveValue('')
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeDisabled()

    // "notes" collides (case-insensitively) with the existing graph —
    // creating it would land inside that folder, so Create refuses and the
    // field says why.
    await userEvent.type(nameInput, 'notes')
    await expect.element(nameInput).toHaveAttribute('aria-invalid', 'true')
    await expect.element(page.getByText('That name already exists in iCloud Drive.')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeDisabled()

    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Journal')
    await expect
      .element(page.getByText('That name already exists in iCloud Drive.'))
      .not.toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await vi.waitFor(() => expect(createGraphAt).toHaveBeenCalledWith('/icloud/Documents/Journal'))
  })

  it('explains itself when iCloud is unreachable and disables Create', async () => {
    await renderChooser()

    await expect.element(page.getByText(/Sign in to iCloud on this Mac/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('hides the iCloud card outside macOS builds and drops the Mac-specific copy', async () => {
    await renderChooser({ buildPlatform: 'windows' })

    await expect.element(page.getByRole('heading', { name: 'A folder you choose' })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'iCloud' })).not.toBeInTheDocument()
    await expect.element(page.getByText(/existing Markdown folder on this computer/)).toBeVisible()
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    await renderChooser()

    await expect.element(page.getByText('personal', { exact: true })).toBeVisible()
    await expect.element(page.getByText('/graphs/personal')).toBeVisible()

    await userEvent.click(page.getByText('personal', { exact: true }))
    await vi.waitFor(() => expect(openRecent).toHaveBeenCalledWith('/graphs/personal'))
  })

  it('forgets a recent graph and refreshes the list', async () => {
    await renderChooser()

    await expect.element(page.getByText('personal', { exact: true })).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Forget personal' }))

    await expect.element(page.getByText('personal', { exact: true })).not.toBeInTheDocument()
    expect(forgetRecent).toHaveBeenCalledWith('/graphs/personal')
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    await renderChooser({ settings: { graphColors: { '/graphs/personal': 'teal' } } })

    await expect.element(page.getByText('personal', { exact: true })).toBeVisible()
    const personalIcon = page
      .getByRole('button', { name: 'personal /graphs/personal', exact: true })
      .locate('svg')
    await expect.element(personalIcon).toHaveStyle({ color: '#14b8a6' })

    const workIcon = page
      .getByRole('button', { name: 'work /graphs/work', exact: true })
      .locate('svg')
    await expect.element(workIcon).toHaveClass('text-text-muted')
  })
})
