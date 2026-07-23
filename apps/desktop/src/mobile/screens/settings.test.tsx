import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getConflictedNotes, type GraphInfo, type Settings } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller'
import '@/test-utils/locator'
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

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

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

// The prompt editor's state and save wiring render through this open-state shell.
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

beforeEach(async () => {
  await page.viewport(375, 700)
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

afterEach(async () => {
  await cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MobileSettings />
    </QueryClientProvider>,
  )
}

describe('MobileSettings', () => {
  it('discloses the graph row into the Graphs screen', async () => {
    const user = userEvent
    await mount()

    const graphRow = page.getByRole('button', { name: /Field Notes/ })
    await expect.element(graphRow).toHaveTextContent('iCloud Drive')
    await user.click(graphRow)

    expect(navigate).toHaveBeenCalledWith({ kind: 'graphs' })
  })

  it('opens the privacy policy from the About group', async () => {
    const user = userEvent
    await mount()

    await user.click(page.getByRole('button', { name: 'Privacy Policy' }))

    expect(openUrl).toHaveBeenCalledWith('https://reflect.app/privacy')
  })

  it('writes appearance choices to the settings document', async () => {
    const user = userEvent
    await mount()

    await user.click(page.getByRole('radio', { name: 'Dark' }))
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })

    await user.click(page.getByRole('radio', { name: 'Large' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorTextSize: 'large' })
  })

  it('toggles the editor switches', async () => {
    const user = userEvent
    await mount()

    await user.click(page.getByRole('switch', { name: 'Smooth caret animation' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorSmoothCaretAnimation: false })

    await user.click(page.getByRole('switch', { name: 'Start with a bullet' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorDefaultBullet: false })

    await user.click(page.getByRole('switch', { name: 'Bullet after a heading' }))
    expect(updateSettings).toHaveBeenCalledWith({ editorBulletAfterHeading: false })
  })

  it('toggles audio transcription formatting', async () => {
    const user = userEvent
    await mount()

    const toggle = page.getByRole('switch', { name: 'Transcription auto-format' })
    const descriptionId = toggle.element().getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain(
      'Uses AI to add punctuation, paragraphs, and light Markdown',
    )

    await user.click(toggle)

    expect(updateSettings).toHaveBeenCalledWith({ transcriptionFormat: false })
  })

  it('edits the AI chat system prompt', async () => {
    const user = userEvent
    await mount()

    await user.click(page.getByRole('button', { name: /System prompt.*Default/ }))
    const textarea = page.getByRole('textbox', { name: 'System prompt instructions' })
    await user.type(textarea, 'Challenge my assumptions.')
    await user.click(page.getByRole('button', { name: 'Save' }))

    expect(updateSettings).toHaveBeenCalledWith({
      chatSystemPrompt: 'Challenge my assumptions.',
    })
  })

  it('tracks a prompt that hydrates while its editor is open', async () => {
    const user = userEvent
    const view = await mount()
    await user.click(page.getByRole('button', { name: /System prompt.*Default/ }))

    settingsState.current = {
      ...settingsState.current,
      chatSystemPrompt: 'Persisted instructions loaded from disk.',
    }
    await view.rerender(
      <QueryClientProvider client={queryClient}>
        <MobileSettings />
      </QueryClientProvider>,
    )

    const textarea = page.getByRole('textbox', { name: 'System prompt instructions' })
    await expect.element(textarea).toHaveValue('Persisted instructions loaded from disk.')
    await user.click(page.getByRole('button', { name: 'Save' }))
    expect(updateSettings).toHaveBeenCalledWith({
      chatSystemPrompt: 'Persisted instructions loaded from disk.',
    })
  })

  it('restores the default prompt immediately from the mobile editor', async () => {
    const user = userEvent
    settingsState.current = {
      ...settingsState.current,
      chatSystemPrompt: 'Always answer in haiku.',
    }
    await mount()

    await user.click(page.getByRole('button', { name: /System prompt.*Custom/ }))
    await user.click(page.getByRole('button', { name: 'Use default' }))

    expect(updateSettings).toHaveBeenCalledWith({ chatSystemPrompt: '' })
    await expect
      .element(page.getByRole('textbox', { name: 'System prompt instructions' }))
      .not.toBeInTheDocument()
  })

  it('shows the connected repo and the live plain-language status', async () => {
    await mount()

    await expect.element(page.getByText('alex/notes')).toBeVisible()
    await expect.element(page.getByText('Backed up')).toBeVisible()
    // Never git terms.
    await expect.element(page.getByText(/commit|branch|merge|push|pull/i)).not.toBeInTheDocument()
  })

  it('routes Disconnect through the backup controller and signs out', async () => {
    const user = userEvent
    await mount()

    await user.click(page.getByRole('button', { name: 'Disconnect GitHub' }))

    await vi.waitFor(() => {
      expect(sync.value?.disconnectGraph).toHaveBeenCalledTimes(1)
      expect(sync.value?.signOut).toHaveBeenCalledTimes(1)
    })
  })

  it('offers Connect GitHub for a disconnected local graph and opens the sheet', async () => {
    const user = userEvent
    graphState.mobileStorageKind = 'local'
    sync.value = {
      backup: { phase: 'disconnected' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    await mount()

    await expect
      .element(page.getByText('Sync notes with Reflect on your other devices.'))
      .toBeVisible()
    await user.click(page.getByRole('button', { name: 'Connect GitHub' }))

    await expect.element(page.getByText('connect-github-sheet')).toBeVisible()
  })

  it('hides the connect row once the local graph is connected', async () => {
    graphState.mobileStorageKind = 'local'
    await mount()

    await expect.element(page.getByText('alex/notes')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Disconnect GitHub' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub' }))
      .not.toBeInTheDocument()
  })

  it('never offers connect for iCloud graphs — they sync through the container', async () => {
    sync.value = {
      backup: { phase: 'disconnected' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    await mount()

    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Backup')).not.toBeInTheDocument()
  })

  it('waits out the loading phase — no connect row that could flash', async () => {
    graphState.mobileStorageKind = 'local'
    sync.value = {
      backup: { phase: 'loading' },
      disconnectGraph: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    }
    await mount()

    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Backup')).not.toBeInTheDocument()
  })

  it('degrades to the local groups where no sync lifecycle is mounted', async () => {
    sync.value = null
    await mount()

    await expect.element(page.getByText('Field Notes')).toBeVisible()
    await expect.element(page.getByText('1.2.3')).toBeVisible()
    await expect.element(page.getByText('2')).toBeVisible() // the note count
    await expect.element(page.getByText('Backed up')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Disconnect GitHub' }))
      .not.toBeInTheDocument()
  })
})
