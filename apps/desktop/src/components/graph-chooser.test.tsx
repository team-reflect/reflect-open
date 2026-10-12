import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
import { setBridge } from '@reflect/core'
import { GraphProvider } from '@/providers/graph-provider.tsx'
import { SettingsProvider } from '@/providers/settings-provider.tsx'
import '@/test-utils/locator.ts'
import { GraphChooser } from './graph-chooser.tsx'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
// The restore card's GitHub step probes the stored sign-in over the network.
vi.mock('@/lib/github-account.ts', () => ({
  fetchSignedInUser: vi.fn(async () =>
    secrets['github-auth'] === undefined ? null : { login: 'alex', avatarUrl: null },
  ),
}))

let invokeLog: Array<[string, Record<string, unknown>]>
let recents: Array<{ root: string; name: string; openedMs: number }>
let storedSettings: Record<string, unknown>
let secrets: Record<string, string>
let icloudStatusResponse: {
  available: boolean
  documentsRoot: string | null
  existingGraphRoots: string[]
}
let queryClient: QueryClient

// Mirrors the main.tsx provider order: settings above the graph lifecycle.
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <GraphProvider>{children}</GraphProvider>
      </SettingsProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
  invokeLog = []
  recents = [
    { root: '/graphs/work', name: 'work', openedMs: 2 },
    { root: '/graphs/personal', name: 'personal', openedMs: 1 },
  ]
  storedSettings = {}
  secrets = {}
  vi.mocked(open).mockReset()
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
        case 'vault_scan_stats':
          return { notes: 0, attachments: 0, skipped: 0 }
        case 'settings_load':
          return storedSettings
        case 'secret_get':
          return secrets[String(args['name'])] ?? null
        case 'git_clone':
          return null
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
    await expect.element(page.getByText(/Open an existing folder/)).toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'A folder you choose' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Choose a folder/ })).toBeVisible()
    await expect.element(page.getByText(/Reflect keeps its files where they are/)).toBeVisible()
  })

  it('creates an iCloud graph from the typed name', async () => {
    icloudStatusResponse = {
      available: true,
      documentsRoot: '/icloud/Documents',
      existingGraphRoots: [],
    }
    await render(<GraphChooser />, { wrapper })

    const nameInput = page.getByRole('textbox', { name: 'Name' })
    // The input starts disabled until `icloud_status` resolves; typing into it
    // before then throws on slower engines (WebKit).
    await expect.element(nameInput).toBeEnabled()
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
    await expect.element(page.getByText('Open an existing graph from iCloud Drive.')).toBeVisible()
    await expect.element(page.getByText('or create new graph')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Work', exact: true }))

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

    await expect.element(page.getByRole('heading', { name: 'A folder you choose' })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: 'iCloud' })).not.toBeInTheDocument()
    await expect.element(page.getByText(/existing Markdown folder on this computer/)).toBeVisible()
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal', { exact: true })).toBeVisible()
    await expect.element(page.getByText('/graphs/personal')).toBeVisible()

    await userEvent.click(page.getByText('personal', { exact: true }))
    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/personal' }]),
    )
  })

  it('forgets a recent graph and refreshes the list', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal', { exact: true })).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Forget personal' }))

    await expect.element(page.getByText('personal', { exact: true })).not.toBeInTheDocument()
    expect(invokeLog).toContainEqual(['forget_recent', { root: '/graphs/personal' }])
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    storedSettings = { graphColors: { '/graphs/personal': 'teal' } }
    await render(<GraphChooser />, { wrapper })

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
  it('restores a GitHub backup into the chosen folder and opens it', async () => {
    secrets['github-auth'] = JSON.stringify({ kind: 'pat', token: 'tok' })
    vi.mocked(open).mockResolvedValue('/graphs')
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByRole('heading', { name: 'Restore from a backup' })).toBeVisible()
    const restore = page.getByRole('button', { name: /Choose where to restore/ })
    await expect.element(restore).toBeDisabled() // nothing typed yet
    await userEvent.type(page.getByRole('textbox', { name: 'Repository' }), 'alex/notes')
    await expect.element(restore).toBeEnabled()
    await userEvent.click(restore)

    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual([
        'git_clone',
        {
          url: 'https://github.com/alex/notes.git',
          path: '/graphs/notes',
          credential: { username: 'x-access-token', secret: 'tok' },
        },
      ]),
    )
    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/notes' }]),
    )
  })

  it('asks for the GitHub sign-in before restoring a GitHub repository', async () => {
    await render(<GraphChooser />, { wrapper })

    await userEvent.type(page.getByRole('textbox', { name: 'Repository' }), 'alex/notes')
    await expect.element(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /Choose where to restore/ }))
      .toBeDisabled()
  })

  it('restores from another host with its stored sign-in, without the GitHub step', async () => {
    secrets['git-host:gitlab.com'] = JSON.stringify({ username: 'alex', secret: 'glpat' })
    vi.mocked(open).mockResolvedValue('/graphs')
    await render(<GraphChooser />, { wrapper })

    await userEvent.type(
      page.getByRole('textbox', { name: 'Repository' }),
      'https://gitlab.com/alex/my-notes.git',
    )
    expect(page.getByRole('button', { name: 'Sign in with GitHub' }).query()).toBeNull()
    await userEvent.click(page.getByRole('button', { name: /Choose where to restore/ }))

    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual([
        'git_clone',
        {
          url: 'https://gitlab.com/alex/my-notes.git',
          path: '/graphs/my-notes',
          credential: { username: 'alex', secret: 'glpat' },
        },
      ]),
    )
  })

  it('a cancelled folder picker restores nothing', async () => {
    secrets['git-host:gitlab.com'] = JSON.stringify({ username: 'alex', secret: 'glpat' })
    vi.mocked(open).mockResolvedValue(null)
    await render(<GraphChooser />, { wrapper })

    await userEvent.type(
      page.getByRole('textbox', { name: 'Repository' }),
      'https://gitlab.com/alex/notes.git',
    )
    await userEvent.click(page.getByRole('button', { name: /Choose where to restore/ }))
    await vi.waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled())
    expect(invokeLog.map(([command]) => command)).not.toContain('git_clone')
  })

  it('refuses to restore into iCloud Drive, where the graph would sync twice', async () => {
    secrets['git-host:gitlab.com'] = JSON.stringify({ username: 'alex', secret: 'glpat' })
    vi.mocked(open).mockResolvedValue('/Users/alex/Library/Mobile Documents/com~apple~CloudDocs')
    await render(<GraphChooser />, { wrapper })

    await userEvent.type(
      page.getByRole('textbox', { name: 'Repository' }),
      'https://gitlab.com/alex/notes.git',
    )
    await userEvent.click(page.getByRole('button', { name: /Choose where to restore/ }))

    await expect.element(page.getByText(/Choose a folder outside iCloud Drive/)).toBeVisible()
    expect(invokeLog.map(([command]) => command)).not.toContain('git_clone')
  })

  it('a folder picker that fails shows the failure in the card', async () => {
    secrets['git-host:gitlab.com'] = JSON.stringify({ username: 'alex', secret: 'glpat' })
    vi.mocked(open).mockRejectedValue(new Error('the dialog could not open'))
    await render(<GraphChooser />, { wrapper })

    await userEvent.type(
      page.getByRole('textbox', { name: 'Repository' }),
      'https://gitlab.com/alex/notes.git',
    )
    await userEvent.click(page.getByRole('button', { name: /Choose where to restore/ }))

    await expect.element(page.getByText('the dialog could not open')).toBeVisible()
  })
})
