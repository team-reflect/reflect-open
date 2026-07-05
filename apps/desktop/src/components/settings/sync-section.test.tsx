import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
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

const platform = vi.hoisted(() => ({ isMacosDesktop: true }))

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

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  icloudStatus: vi.fn(async () => core.status),
  icloudPendingCount: vi.fn(async () => core.pendingNotes),
  getConflictedNotes: vi.fn(async () => core.conflictedNotes),
  getDuplicateNoteIds: vi.fn(async () => core.duplicateIds),
}))
vi.mock('@/lib/platform', () => ({
  get isMacosDesktop(): boolean {
    return platform.isMacosDesktop
  },
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: graph.current, openRecent: graph.openRecent }),
}))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))

function renderSection(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncSection />
    </QueryClientProvider>,
  )
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
  platform.isMacosDesktop = true
  sync.backup = { phase: 'disconnected' }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SyncSection', () => {
  it('combines iCloud Drive and GitHub backup under Sync for local graphs', async () => {
    renderSection()

    const section = screen.getByRole('region', { name: 'Sync' })
    expect(within(section).getByText('iCloud Drive', { selector: 'legend' })).toBeTruthy()
    expect(await within(section).findByText('1 graph in iCloud Drive.')).toBeTruthy()
    expect(within(section).getByText('GitHub backup', { selector: 'legend' })).toBeTruthy()
    expect(within(section).getByRole('button', { name: /connect github/i })).toBeTruthy()
  })

  it('keeps GitHub backup visible when the graph syncs through iCloud', async () => {
    graph.current = {
      root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
      name: 'Notes',
      generation: 1,
    }

    renderSection()

    const section = screen.getByRole('region', { name: 'Sync' })
    expect(within(section).getByText('iCloud Drive', { selector: 'legend' })).toBeTruthy()
    expect(await within(section).findByText('All note files are downloaded.')).toBeTruthy()
    expect(within(section).getByText('No notes need review.')).toBeTruthy()
    expect(within(section).getByText('GitHub backup', { selector: 'legend' })).toBeTruthy()
    expect(within(section).getByRole('button', { name: /connect github/i })).toBeTruthy()
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

    renderSection()

    const section = screen.getByRole('region', { name: 'Sync' })
    expect(
      await within(section).findByText('2 notes are still downloading from iCloud.'),
    ).toBeTruthy()
    expect(within(section).getByText('1 note needs review, 1 sync fork')).toBeTruthy()
  })

  it('keeps backup visible when the iCloud row is platform-hidden', () => {
    platform.isMacosDesktop = false
    graph.current = {
      root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
      name: 'Notes',
      generation: 1,
    }

    renderSection()

    const section = screen.getByRole('region', { name: 'Sync' })
    expect(within(section).queryByText('iCloud Drive', { selector: 'legend' })).toBeNull()
    expect(within(section).getByText('GitHub backup', { selector: 'legend' })).toBeTruthy()
  })
})
