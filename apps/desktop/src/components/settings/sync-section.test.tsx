import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page, type Locator } from 'vitest/browser'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
import '@/test-utils/locator'
import { RouterProvider, useRouter } from '@/routing/router'
import { SyncSection } from './sync-section'

const core = vi.hoisted(() => ({
  status: {
    available: true,
    documentsRoot: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents',
    existingGraphRoots: [] as string[],
  },
  pendingNotes: 0,
  conflictedNotes: [] as Array<{ path: string; title: string }>,
  duplicateIds: [] as Array<{ id: string; paths: string[] }>,
}))

const graph = vi.hoisted(() => ({
  current: null as GraphInfo | null,
  openRecent: vi.fn<(root: string) => Promise<boolean>>(async () => true),
}))

const sync = vi.hoisted(() => ({
  backup: { phase: 'disconnected' } as BackupState,
  disconnectGraph: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  backUpNow: vi.fn(async () => {}),
}))

const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  icloudStatus: vi.fn(async () => core.status),
  icloudPendingCount: vi.fn(async () => core.pendingNotes),
  getConflictedNotes: vi.fn(async () => core.conflictedNotes),
  getDuplicateNoteIds: vi.fn(async () => core.duplicateIds),
}))
// A browser-mode module mock materializes value exports once, so this file
// keeps the flag statically true; the platform-hidden test lives in
// `sync-section-non-macos.test.tsx`.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: graph.current, openRecent: graph.openRecent }),
}))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))

async function renderSection(): Promise<void> {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider initialRoute={{ kind: 'settings' }}>
        <SyncSection />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{route.kind === 'note' ? route.path : route.kind}</output>
}

function legend(section: Locator, text: string): Locator {
  return section.locate('legend').filter({ hasText: text })
}

beforeEach(() => {
  graph.current = {
    root: '/Users/alex/Documents/Notes',
    name: 'Notes',
    generation: 1,
  }
  core.status = {
    available: true,
    documentsRoot: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents',
    existingGraphRoots: ['/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Personal'],
  }
  core.pendingNotes = 0
  core.conflictedNotes = []
  core.duplicateIds = []
  sync.backup = { phase: 'disconnected' }
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
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
    graph.current = {
      root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
      name: 'Notes',
      generation: 1,
    }

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect.element(legend(section, 'iCloud Drive')).toBeInTheDocument()
    await expect.element(section.getByText('All note files are downloaded.')).toBeInTheDocument()
    await expect.element(section.getByText('No notes need review.')).toBeInTheDocument()
    await expect.element(legend(section, 'GitHub sync')).toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: /connect github/i }))
      .toBeInTheDocument()
  })

  it('surfaces iCloud download and review counts', async () => {
    graph.current = {
      root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
      name: 'Notes',
      generation: 1,
    }
    core.pendingNotes = 2
    core.conflictedNotes = [{ path: 'notes/a.md', title: 'A' }]
    core.duplicateIds = [{ id: 'note-1', paths: ['notes/a.md', 'notes/a 2.md'] }]

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await expect
      .element(section.getByText('2 notes are still downloading from iCloud.'))
      .toBeInTheDocument()
    await expect
      .element(section.getByText('1 note needs review, 1 sync fork'))
      .toBeInTheDocument()
    await expect
      .element(section.getByRole('button', { name: /A.*notes\/a\.md/ }))
      .toBeInTheDocument()
  })

  it('opens the conflicted note listed under GitHub sync', async () => {
    core.conflictedNotes = [{ path: 'notes/conflicted.md', title: 'Conflicted note' }]
    sync.backup = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    }

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await section
      .getByRole('button', { name: /Conflicted note.*notes\/conflicted\.md/ })
      .click()

    await expect.element(page.getByTestId('route')).toHaveTextContent('notes/conflicted.md')
  })

  it('opens a ⌘-clicked conflicted note in a new window', async () => {
    core.conflictedNotes = [{ path: 'notes/conflicted.md', title: 'Conflicted note' }]
    sync.backup = {
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    }

    await renderSection()

    const section = page.getByRole('region', { name: 'Sync' })
    await section
      .getByRole('button', { name: /Conflicted note.*notes\/conflicted\.md/ })
      .click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/conflicted.md',
      }),
    )
    expect(page.getByTestId('route').element().textContent).toBe('settings')
  })
})
