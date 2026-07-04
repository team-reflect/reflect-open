import { useEffect, type ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConflictedNotes, type GraphInfo } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
import { SettingsSheet } from './settings-sheet'

/**
 * The settings sheet's sync surface (Plan 19, step 10): the live
 * plain-language backup status from the engine (no git terms), the connected
 * repo with Disconnect routed through the backup controller (so the engine
 * actually stops), graceful degradation where no SyncProvider is mounted,
 * and the graph switcher (Plan 21 — the container can hold several graphs).
 */

// vaul needs browser APIs jsdom doesn't provide; passthrough so the sheet
// content always renders (the drawer itself is verified on-device). The
// Drawer mock reports itself open so the sheet's open-gated queries run.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    useEffect(() => {
      onOpenChange?.(true)
    }, [onOpenChange])
    return <>{children}</>
  },
  DrawerTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const storageInfo = vi.hoisted(() => ({
  current: {
    localRoot: '/Documents',
    icloudDocumentsRoot: null as string | null,
    icloudGraphRoots: [] as string[],
  },
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  listNotes: vi.fn(async () => [{ path: 'notes/a.md' }, { path: 'notes/b.md' }]),
  getConflictedNotes: vi.fn(async () => []),
  mobileStorage: vi.fn(async () => storageInfo.current),
}))

const completeOnboarding = vi.hoisted(() =>
  vi.fn(async (_kind: string, _root?: string) => {}),
)
const graphState = vi.hoisted(() => ({
  mobileStorageKind: null as 'icloud' | 'local' | null,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'Field Notes', generation: 1 } as GraphInfo,
    mobileStorageKind: graphState.mobileStorageKind,
    completeOnboarding,
  }),
}))
vi.mock('@/hooks/use-app-version', () => ({ useAppVersion: () => '1.2.3' }))

const sync = vi.hoisted(() => ({
  value: null as {
    backup: BackupState
    disconnectGraph: () => Promise<void>
    signOut: () => Promise<void>
  } | null,
}))
vi.mock('@/providers/sync-provider', () => ({
  useSyncContext: () => sync.value,
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
  sync.value = {
    backup: connected({ state: 'idle' }),
    disconnectGraph: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  graphState.mobileStorageKind = null
  storageInfo.current = { localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] }
  vi.mocked(getConflictedNotes).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function mount(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsSheet />
    </QueryClientProvider>,
  )
}

describe('SettingsSheet', () => {
  it('shows the connected repo and the live plain-language status', async () => {
    mount()

    expect(await screen.findByText('alex/notes')).toBeTruthy()
    expect(await screen.findByText('Backed up')).toBeTruthy()
    // Never git terms.
    expect(screen.queryByText(/commit|branch|merge|push|pull/i)).toBeNull()
  })

  it('shows no status until the conflict count is known — never a flip', async () => {
    vi.mocked(getConflictedNotes).mockReturnValue(new Promise(() => {}))
    mount()

    expect(await screen.findByText('alex/notes')).toBeTruthy()
    expect(screen.queryByText('Backed up')).toBeNull()
  })

  it('shows Needs review with its mobile resolution pointer when notes conflict', async () => {
    vi.mocked(getConflictedNotes).mockResolvedValue([{ path: 'notes/a.md', title: 'A' }])
    mount()

    expect(await screen.findByText('Needs review')).toBeTruthy()
    expect(screen.getByText(/open it to choose what to keep/i)).toBeTruthy()
  })

  it('routes Disconnect through the backup controller and signs out', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(sync.value?.disconnectGraph).toHaveBeenCalledTimes(1)
      expect(sync.value?.signOut).toHaveBeenCalledTimes(1)
    })
  })

  it('degrades to the local rows where no sync lifecycle is mounted', async () => {
    sync.value = null
    mount()

    expect(await screen.findByText('Field Notes')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(screen.queryByText('Backed up')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  it('lists the other graphs and switches through the onboarding flow', async () => {
    graphState.mobileStorageKind = 'icloud'
    storageInfo.current = {
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: ['/iCloud/Documents/Work'],
    }
    const user = userEvent.setup()
    mount()

    expect(await screen.findByText('Switch graph')).toBeTruthy()
    // Every other container graph, plus the on-device root for iCloud graphs.
    expect(screen.getByRole('button', { name: 'This device' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Work' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work'),
    )
  })

  it('creates a new iCloud graph through the switcher', async () => {
    graphState.mobileStorageKind = 'local'
    storageInfo.current = {
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: [],
    }
    const user = userEvent.setup()
    mount()

    expect(await screen.findByText('Switch graph')).toBeTruthy()
    await user.clear(screen.getByLabelText('New iCloud graph'))
    await user.type(screen.getByLabelText('New iCloud graph'), 'Journal')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('offers no switcher when there is nowhere else to go', async () => {
    // A local graph with an empty container: the open graph is the only one.
    graphState.mobileStorageKind = 'local'
    mount()

    expect(await screen.findByText('Field Notes')).toBeTruthy()
    expect(screen.queryByText('Switch graph')).toBeNull()
  })
})
