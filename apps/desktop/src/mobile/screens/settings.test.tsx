import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getConflictedNotes, type GraphInfo, type Settings } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
import { MobileSettings } from './settings'

/**
 * The mobile Settings screen (the pushed card that replaced the bottom
 * sheet): the graph row disclosing into the Graphs screen, appearance and
 * editor preferences writing the shared settings document, the backup group's
 * plain-language status + Disconnect through the backup controller, and
 * graceful degradation where no SyncProvider is mounted.
 */

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  listNotes: vi.fn(async () => [{ path: 'notes/a.md' }, { path: 'notes/b.md' }]),
  getConflictedNotes: vi.fn(async () => []),
}))

const graphState = vi.hoisted(() => ({
  mobileStorageKind: 'icloud' as 'icloud' | 'local' | null,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'Field Notes', generation: 1 } as GraphInfo,
    mobileStorageKind: graphState.mobileStorageKind,
  }),
}))
vi.mock('@/hooks/use-app-version', () => ({ useAppVersion: () => '1.2.3-beta.4' }))

const settingsState = vi.hoisted(() => ({ current: {} as Settings }))
const updateSettings = vi.hoisted(() => vi.fn())
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settingsState.current, updateSettings }),
}))

const navigate = vi.hoisted(() => vi.fn())
const back = vi.hoisted(() => vi.fn())
vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate, back, canBack: true }),
}))

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

// vaul's gestures need browser APIs jsdom does not provide. The prompt
// editor's state and save wiring still render through this open-state shell.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: import('react').ReactNode }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  DrawerContent: ({ children }: { children?: import('react').ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: import('react').ReactNode }) => <h2>{children}</h2>,
}))

// The sheet itself is covered by connect-github-drawer.test.tsx; the screen
// test only cares that Settings opens it.
vi.mock('@/mobile/connect-github-drawer', () => ({
  ConnectGithubDrawer: ({ open }: { open: boolean }) =>
    open ? <div>connect-github-sheet</div> : null,
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
  settingsState.current = { ...DEFAULT_SETTINGS }
  graphState.mobileStorageKind = 'icloud'
  sync.value = {
    backup: connected({ state: 'idle' }),
    disconnectGraph: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  vi.mocked(getConflictedNotes).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function mount(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={queryClient}>
      <MobileSettings />
    </QueryClientProvider>,
  )
}

describe('MobileSettings', () => {
  it('discloses the graph row into the Graphs screen', async () => {
    const user = userEvent.setup()
    mount()

    const graphRow = screen.getByRole('button', { name: /Field Notes/ })
    expect(graphRow.textContent).toContain('iCloud Drive')
    await user.click(graphRow)

    expect(navigate).toHaveBeenCalledWith({ kind: 'graphs' })
  })

  it('writes appearance choices to the settings document', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })

    await user.click(screen.getByRole('radio', { name: 'Large' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorTextSize: 'large' })
  })

  it('toggles the editor switches', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('switch', { name: 'Smooth caret animation' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorSmoothCaretAnimation: false })

    await user.click(screen.getByRole('switch', { name: 'Start with a bullet' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorDefaultBullet: false })

    await user.click(screen.getByRole('switch', { name: 'Bullet after a heading' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorBulletAfterHeading: false })
  })

  it('toggles audio transcription formatting', async () => {
    const user = userEvent.setup()
    mount()

    const toggle = screen.getByRole('switch', { name: 'Transcription auto-format' })
    const descriptionId = toggle.getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain(
      'Uses AI to add punctuation, paragraphs, and light Markdown',
    )

    await user.click(toggle)

    expect(updateSettings).toHaveBeenCalledWith({ transcriptionFormat: false })
  })

  it('edits the AI chat system prompt', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: /System prompt.*Default/ }))
    const textarea = screen.getByRole('textbox', { name: 'System prompt instructions' })
    await user.type(textarea, 'Challenge my assumptions.')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(updateSettings).toHaveBeenCalledWith({
      chatSystemPrompt: 'Challenge my assumptions.',
    })
  })

  it('tracks a prompt that hydrates while its editor is open', async () => {
    const user = userEvent.setup()
    const view = mount()
    await user.click(screen.getByRole('button', { name: /System prompt.*Default/ }))

    settingsState.current = {
      ...settingsState.current,
      chatSystemPrompt: 'Persisted instructions loaded from disk.',
    }
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MobileSettings />
      </QueryClientProvider>,
    )

    const textarea = screen.getByRole('textbox', { name: 'System prompt instructions' })
    expect((textarea as HTMLTextAreaElement).value).toBe('Persisted instructions loaded from disk.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateSettings).toHaveBeenCalledWith({
      chatSystemPrompt: 'Persisted instructions loaded from disk.',
    })
  })

  it('restores the default prompt immediately from the mobile editor', async () => {
    const user = userEvent.setup()
    settingsState.current = {
      ...settingsState.current,
      chatSystemPrompt: 'Always answer in haiku.',
    }
    mount()

    await user.click(screen.getByRole('button', { name: /System prompt.*Custom/ }))
    await user.click(screen.getByRole('button', { name: 'Use default' }))

    expect(updateSettings).toHaveBeenCalledWith({ chatSystemPrompt: '' })
    expect(screen.queryByRole('textbox', { name: 'System prompt instructions' })).toBeNull()
  })

  it('shows the connected repo and the live plain-language status', async () => {
    mount()

    expect(await screen.findByText('alex/notes')).toBeTruthy()
    expect(await screen.findByText('Backed up')).toBeTruthy()
    // Never git terms.
    expect(screen.queryByText(/commit|branch|merge|push|pull/i)).toBeNull()
  })

  it('routes Disconnect through the backup controller and signs out', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }))

    await waitFor(() => {
      expect(sync.value?.disconnectGraph).toHaveBeenCalledTimes(1)
      expect(sync.value?.signOut).toHaveBeenCalledTimes(1)
    })
  })

  it('offers Connect GitHub for a disconnected local graph and opens the sheet', async () => {
    const user = userEvent.setup()
    graphState.mobileStorageKind = 'local'
    sync.value = {
      backup: { phase: 'disconnected' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    mount()

    expect(screen.getByText('Sync notes with Reflect on your other devices.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Connect GitHub' }))

    expect(await screen.findByText('connect-github-sheet')).toBeTruthy()
  })

  it('hides the connect row once the local graph is connected', async () => {
    graphState.mobileStorageKind = 'local'
    mount()

    expect(await screen.findByText('alex/notes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disconnect GitHub' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull()
  })

  it('never offers connect for iCloud graphs — they sync through the container', () => {
    sync.value = {
      backup: { phase: 'disconnected' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    mount()

    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull()
    expect(screen.queryByText('Backup')).toBeNull()
  })

  it('waits out the loading phase — no connect row that could flash', () => {
    graphState.mobileStorageKind = 'local'
    sync.value = {
      backup: { phase: 'loading' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    mount()

    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull()
    expect(screen.queryByText('Backup')).toBeNull()
  })

  it('degrades to the local groups where no sync lifecycle is mounted', async () => {
    sync.value = null
    mount()

    expect(await screen.findByText('Field Notes')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(await screen.findByText('2')).toBeTruthy() // the note count
    expect(screen.queryByText('Backed up')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect GitHub' })).toBeNull()
  })
})
