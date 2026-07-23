import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { GraphProvider } from '@/providers/graph-provider'
import { SettingsProvider } from '@/providers/settings-provider'
import '@/test-utils/locator'
import { GraphChooser } from './graph-chooser'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

let invokeLog: Array<[string, Record<string, unknown>]>
let recents: Array<{ root: string; name: string; openedMs: number }>
let storedSettings: Record<string, unknown>
let icloudStatusResponse: {
  available: boolean
  documentsRoot: string | null
  existingGraphRoots: string[]
}
let queryClient: QueryClient

// Mirrors the main.tsx provider order: settings above the graph lifecycle.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <GraphProvider>{children}</GraphProvider>
    </SettingsProvider>
  </QueryClientProvider>
)

beforeEach(() => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
  invokeLog = []
  recents = [
    { root: '/graphs/work', name: 'work', openedMs: 2 },
    { root: '/graphs/personal', name: 'personal', openedMs: 1 },
  ]
  storedSettings = {}
  icloudStatusResponse = { available: false, documentsRoot: null, existingGraphRoots: [] }
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  setBridge({
    invoke: async (command, args) => {
      invokeLog.push([command, args])
      switch (command) {
        case 'recent_graphs':
          return recents
        case 'forget_recent':
          recents = recents.filter((recent) => recent.root !== args['root'])
          return null
        case 'graph_open':
        case 'graph_create':
          return { root: String(args['path']), name: 'work', generation: 1 }
        case 'icloud_status':
          return icloudStatusResponse
        case 'index_open':
          return 1
        case 'list_files':
        case 'db_query':
          return []
        case 'settings_load':
          return storedSettings
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllEnvs()
  setBridge(null)
  queryClient.clear()
})

describe('GraphChooser', () => {
  it('leads with iCloud (recommended) beside the pick-a-folder path', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: [],
    }
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByRole('heading', { name: 'iCloud' })).toBeVisible()
    await expect.element(page.getByText('Recommended')).toBeVisible()
    await expect
      .element(page.getByRole('heading', { name: 'A folder you choose' }))
      .toBeVisible()
    await expect.element(page.getByRole('button', { name: /Choose a folder/ })).toBeVisible()
  })

  it('creates an iCloud graph from the typed name', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: [],
    }
    await render(<GraphChooser />, { wrapper })

    const nameInput = page.getByRole('textbox', { name: 'Name' })
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'My Notes')
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_create', { path: '/icloud/Documents/My Notes' }]),
    )
  })

  it('lists every graph already in the container and opens the clicked one', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: ['/icloud/Documents/Notes', '/icloud/Documents/Work'],
    }
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByRole('button', { name: 'Notes' })).toBeVisible()
    await expect
      .element(page.getByText('Open an existing graph from iCloud Drive.'))
      .toBeVisible()
    await expect.element(page.getByText('or create new graph')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Work' }))

    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/icloud/Documents/Work' }]),
    )
  })

  it('creates a new graph alongside existing ones, refusing taken names', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: ['/icloud/Documents/Notes'],
    }
    await render(<GraphChooser />, { wrapper })

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

    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_create', { path: '/icloud/Documents/Journal' }]),
    )
  })

  it('explains itself when iCloud is unreachable and disables Create', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText(/Sign in to iCloud on this Mac/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('hides the iCloud card outside macOS builds and drops the Mac-specific copy', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'windows')
    await render(<GraphChooser />, { wrapper })

    await expect
      .element(page.getByRole('heading', { name: 'A folder you choose' }))
      .toBeVisible()
    await expect
      .element(page.getByRole('heading', { name: 'iCloud' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText(/any folder on this computer/)).toBeVisible()
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal')).toBeVisible()
    await expect.element(page.getByText('/graphs/personal')).toBeVisible()

    await userEvent.click(page.getByText('personal'))
    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/personal' }]),
    )
  })

  it('forgets a recent graph and refreshes the list', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Forget personal' }))

    await expect.element(page.getByText('personal')).not.toBeInTheDocument()
    expect(invokeLog).toContainEqual(['forget_recent', { root: '/graphs/personal' }])
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    storedSettings = { graphColors: { '/graphs/personal': 'teal' } }
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal')).toBeVisible()
    const personalIcon = page.getByRole('button', { name: /personal/ }).locate('svg')
    await expect.element(personalIcon).toHaveStyle({ color: '#14b8a6' })

    const workIcon = page.getByRole('button', { name: /work/ }).locate('svg')
    await expect.element(workIcon).toHaveClass('text-text-muted')
  })
})
