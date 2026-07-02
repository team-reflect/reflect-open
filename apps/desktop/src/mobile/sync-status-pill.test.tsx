import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConflictedNotes, type GraphInfo } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
import { publishKeyboardHeight } from '@/mobile/use-keyboard'
import { SyncStatusPill } from './sync-status-pill'

/**
 * The floating status pill (Plan 19, step 10): visible only when sync has
 * something to say, plain language only, and it yields to the keyboard.
 */

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getConflictedNotes: vi.fn(async () => []),
}))

const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'G', generation: 3 } as GraphInfo | null,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))

const sync = vi.hoisted(() => ({ backup: { phase: 'loading' } as BackupState }))
vi.mock('@/providers/sync-provider', () => ({
  useSyncContext: () => ({ backup: sync.backup }),
}))

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  sync.backup = connected({ state: 'idle' })
  vi.mocked(getConflictedNotes).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  publishKeyboardHeight(0)
  vi.clearAllMocks()
})

function mount(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SyncStatusPill />
    </QueryClientProvider>,
  )
}

describe('SyncStatusPill', () => {
  it('hides in the quiet Backed up state', async () => {
    mount()

    await Promise.resolve()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows Syncing while a cycle runs', async () => {
    sync.backup = connected({ state: 'syncing' })
    mount()

    expect((await screen.findByRole('status')).textContent).toBe('Syncing')
  })

  it('claims nothing until the conflict count is known', async () => {
    // A pill shown before the count resolves could flip from hidden
    // (reads as Backed up) to Needs review.
    sync.backup = connected({ state: 'offline', message: 'Offline' })
    vi.mocked(getConflictedNotes).mockReturnValue(new Promise(() => {}))
    mount()

    await Promise.resolve()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still shows engine states when the conflict count fails to load', async () => {
    // Loading hides; a failed count must not — Offline/Needs attention are
    // engine truth and would otherwise blank forever.
    sync.backup = connected({ state: 'offline', message: 'Offline' })
    vi.mocked(getConflictedNotes).mockRejectedValue(new Error('index unavailable'))
    mount()

    expect((await screen.findByRole('status')).textContent).toBe('Offline')
  })

  it('shows Needs review while conflicted notes exist', async () => {
    vi.mocked(getConflictedNotes).mockResolvedValue([{ path: 'notes/a.md', title: 'A' }])
    mount()

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Needs review')
    })
  })

  it('yields to the software keyboard', async () => {
    sync.backup = connected({ state: 'syncing' })
    publishKeyboardHeight(300)
    mount()

    await Promise.resolve()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
