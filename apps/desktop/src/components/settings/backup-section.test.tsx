import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackupState } from '@/lib/backup-controller'
import { BackupSettingsField } from './backup-section'

// The section's GitHub-vs-generic split (Plan 16): a hand-wired remote must
// render host-neutrally, and its auth errors must surface the engine's
// actionable message — "reconnect GitHub" can't fix an ssh-agent problem.

const sync = vi.hoisted(() => ({
  backup: { phase: 'loading' } as BackupState,
  disconnectGraph: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  backUpNow: vi.fn(async () => {}),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => ({ graph: null }) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSection(backup: BackupState): void {
  sync.backup = backup
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BackupSettingsField />
    </QueryClientProvider>,
  )
}

const AUTH_ERROR = {
  state: 'error',
  errorKind: 'auth',
  message: 'the SSH agent offered no key this host accepts — `ssh-add` the right key',
} as const

describe('BackupSettingsField', () => {
  it('renders a generic remote host-neutrally with the engine’s own auth message', async () => {
    renderSection({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      repo: null,
      status: AUTH_ERROR,
    })

    expect(await screen.findByText('Backup', { selector: 'legend' })).toBeTruthy()
    expect(screen.queryByText('GitHub sync')).toBeNull()
    expect(screen.getByText('git@gitlab.com:alex/notes.git')).toBeTruthy()
    // The actionable message, not a GitHub reconnect that can't help.
    expect(screen.getByText(/ssh-add/)).toBeTruthy()
    expect(screen.queryByText(/reconnect GitHub/)).toBeNull()
    // Machine-level GitHub sign-out is noise next to a non-GitHub graph.
    expect(screen.queryByRole('button', { name: /Sign out of GitHub/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open GitHub repo' })).toBeNull()
  })

  it('renders a GitHub remote with the reconnect affordances', async () => {
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: AUTH_ERROR,
    })

    expect(await screen.findByText('GitHub sync')).toBeTruthy()
    expect(screen.getByText('alex/notes')).toBeTruthy()
    expect(screen.getByText(/reconnect GitHub/)).toBeTruthy()
    expect(screen.getByText('GitHub account')).toBeTruthy()
    expect(screen.getByText(/connected graphs stop backing up/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open GitHub repo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sign out of GitHub/ })).toBeTruthy()
  })

  it('opens the connected GitHub repository', async () => {
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open GitHub repo' }))

    expect(openUrl).toHaveBeenCalledWith('https://github.com/alex/notes')
  })

  it('keeps unrelated action errors out of the sign-out dialog', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No browser'))
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open GitHub repo' }))

    expect(await screen.findByText(/Couldn’t open the browser/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Sign out of GitHub/ }))

    expect(
      within(screen.getByRole('dialog')).queryByText(/Couldn’t open the browser/),
    ).toBeNull()
  })

  it('clears stale open-repo errors before retrying', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No browser'))
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open GitHub repo' }))

    expect(await screen.findByText(/Couldn’t open the browser/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub repo' }))

    await waitFor(() => expect(screen.queryByText(/Couldn’t open the browser/)).toBeNull())
  })

  it('ignores an older open-repo failure after a newer retry succeeds', async () => {
    let rejectFirstOpen: (reason?: unknown) => void = () => {}
    vi.mocked(openUrl)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstOpen = reject
          }),
      )
      .mockResolvedValueOnce()
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open GitHub repo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub repo' }))

    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))

    rejectFirstOpen(new Error('Old failure'))

    await waitFor(() => expect(screen.queryByText(/Couldn’t open the browser/)).toBeNull())
  })

  it('confirms before signing out of GitHub', async () => {
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: /Sign out of GitHub/ }))

    expect(screen.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeTruthy()
    expect(screen.getByText(/Every GitHub-backed graph will stop backing up/i)).toBeTruthy()
    expect(sync.signOut).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(sync.signOut).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Sign out of GitHub?' })).toBeNull(),
    )
  })

  it('shows sign-out failures inside the confirmation dialog', async () => {
    sync.signOut.mockRejectedValueOnce(new Error('Keychain denied'))
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: /Sign out of GitHub/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign out of GitHub?' })).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByText('Keychain denied')).toBeTruthy()
    expect(screen.getAllByText('Keychain denied')).toHaveLength(1)
  })

  it('does not close the sign-out dialog while sign-out is pending', async () => {
    let resolveSignOut: () => void = () => {}
    sync.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve
        }),
    )
    renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    fireEvent.click(await screen.findByRole('button', { name: /Sign out of GitHub/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeTruthy()

    resolveSignOut()

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Sign out of GitHub?' })).toBeNull(),
    )
  })
})
