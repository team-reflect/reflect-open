import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { GraphProvider } from '@/providers/graph-provider'
import { SettingsProvider } from '@/providers/settings-provider'
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

afterEach(() => {
  cleanup() // `globals: false` disables testing-library's automatic cleanup
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
    render(<GraphChooser />, { wrapper })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'iCloud' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'A folder you choose' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Choose a folder/ })).toBeInTheDocument()
  })

  it('creates an iCloud graph from the typed name', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: [],
    }
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    const nameInput = await screen.findByRole('textbox', { name: 'Name' })
    await user.clear(nameInput)
    await user.type(nameInput, 'My Notes')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_create', { path: '/icloud/Documents/My Notes' }]),
    )
  })

  it('lists every graph already in the container and opens the clicked one', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: ['/icloud/Documents/Notes', '/icloud/Documents/Work'],
    }
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    await screen.findByRole('button', { name: 'Notes' })
    expect(screen.getByText('Open an existing graph from iCloud Drive.')).toBeInTheDocument()
    expect(screen.getByText('or create new graph')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Work' }))

    await waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/icloud/Documents/Work' }]),
    )
  })

  it('creates a new graph alongside existing ones, refusing taken names', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: ['/icloud/Documents/Notes'],
    }
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    // Wait for the status to land (the existing graph is listed) so the
    // compact create row — not the pre-status empty-container form — is the
    // input under test. Next to an existing list the row starts empty.
    await screen.findByRole('button', { name: 'Notes' })
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    expect(nameInput).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    // "notes" collides (case-insensitively) with the existing graph —
    // creating it would land inside that folder, so Create refuses and the
    // field says why.
    await user.type(nameInput, 'notes')
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('That name already exists in iCloud Drive.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    await user.clear(nameInput)
    await user.type(nameInput, 'Journal')
    expect(screen.queryByText('That name already exists in iCloud Drive.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_create', { path: '/icloud/Documents/Journal' }]),
    )
  })

  it('explains itself when iCloud is unreachable and disables Create', async () => {
    render(<GraphChooser />, { wrapper })

    await waitFor(() =>
      expect(screen.getByText(/Sign in to iCloud on this Mac/)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('hides the iCloud card outside macOS builds and drops the Mac-specific copy', async () => {
    vi.stubEnv('TAURI_ENV_PLATFORM', 'windows')
    render(<GraphChooser />, { wrapper })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'A folder you choose' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('heading', { name: 'iCloud' })).not.toBeInTheDocument()
    expect(screen.getByText(/any folder on this computer/)).toBeInTheDocument()
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    expect(screen.getByText('/graphs/personal')).toBeInTheDocument()

    await user.click(screen.getByText('personal'))
    await waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/personal' }]),
    )
  })

  it('forgets a recent graph and refreshes the list', async () => {
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Forget personal' }))

    await waitFor(() => expect(screen.queryByText('personal')).not.toBeInTheDocument())
    expect(invokeLog).toContainEqual(['forget_recent', { root: '/graphs/personal' }])
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    storedSettings = { graphColors: { '/graphs/personal': 'teal' } }
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    const personalIcon = screen.getByText('personal').closest('button')?.querySelector('svg')
    await waitFor(() => expect(personalIcon).toHaveStyle({ color: '#14b8a6' }))

    const workIcon = screen.getByText('work').closest('button')?.querySelector('svg')
    expect(workIcon).toHaveClass('text-text-muted')
  })
})
