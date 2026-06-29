import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { BackupState } from '@/lib/backup-controller'
import { BackupSection } from './backup-section'

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
  vi.clearAllMocks()
})

async function renderSection(backup: BackupState): Promise<void> {
  sync.backup = backup
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <BackupSection />
    </QueryClientProvider>,
  )
}

const AUTH_ERROR = {
  state: 'error',
  errorKind: 'auth',
  message: 'the SSH agent offered no key this host accepts — `ssh-add` the right key',
} as const

describe('BackupSection', () => {
  it('renders a generic remote host-neutrally with the engine’s own auth message', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      repo: null,
      status: AUTH_ERROR,
    })

    // Scope to the fieldset legend: an h2 section heading also reads "Backup".
    await expect.element(page.locate('legend').getByText('Backup', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('GitHub backup', { exact: true })).not.toBeInTheDocument()
    await expect.element(page.getByText('git@gitlab.com:alex/notes.git', { exact: true })).toBeInTheDocument()
    // The actionable message, not a GitHub reconnect that can't help.
    await expect.element(page.getByText(/ssh-add/)).toBeInTheDocument()
    await expect.element(page.getByText(/reconnect GitHub/)).not.toBeInTheDocument()
    // Machine-level GitHub sign-out is noise next to a non-GitHub graph.
    await expect.element(page.getByRole('button', { name: /Sign out of GitHub/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Open GitHub repo', exact: true })).not.toBeInTheDocument()
  })

  it('renders a GitHub remote with the reconnect affordances', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: AUTH_ERROR,
    })

    await expect.element(page.getByText('GitHub backup', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('alex/notes', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText(/reconnect GitHub/)).toBeInTheDocument()
    await expect.element(page.getByText('GitHub account', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText(/connected graphs stop backing up/i)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Open GitHub repo', exact: true })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Sign out of GitHub/ })).toBeInTheDocument()
  })

  it('opens the connected GitHub repository', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))

    expect(openUrl).toHaveBeenCalledWith('https://github.com/alex/notes')
  })

  it('keeps unrelated action errors out of the sign-out dialog', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No browser'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))

    await expect
      .element(page.getByRole('dialog').getByText(/Couldn’t open the browser/))
      .not.toBeInTheDocument()
  })

  it('clears stale open-repo errors before retrying', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No browser'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
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
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))
    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo', exact: true }))

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))

    rejectFirstOpen(new Error('Old failure'))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
  })

  it('confirms before signing out of GitHub', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?', exact: true })).toBeInTheDocument()
    await expect.element(page.getByText(/Every GitHub-backed graph will stop backing up/i)).toBeInTheDocument()
    expect(sync.signOut).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Sign out', exact: true }))

    await vi.waitFor(() => expect(sync.signOut).toHaveBeenCalledTimes(1))
    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?', exact: true })).not.toBeInTheDocument()
  })

  it('shows sign-out failures inside the confirmation dialog', async () => {
    sync.signOut.mockRejectedValueOnce(new Error('Keychain denied'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out', exact: true }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?', exact: true })).toBeInTheDocument()
    await expect.element(page.getByRole('dialog').getByText('Keychain denied', { exact: true })).toBeInTheDocument()
    expect(page.getByText('Keychain denied', { exact: true }).all()).toHaveLength(1)
  })

  it('does not close the sign-out dialog while sign-out is pending', async () => {
    let resolveSignOut: () => void = () => {}
    sync.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve
        }),
    )
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out', exact: true }))
    // Cancel is disabled while the sign-out is pending; dispatch the click
    // directly so the attempt is made without waiting on actionability.
    page
      .getByRole('button', { name: 'Cancel', exact: true })
      .element()
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?', exact: true })).toBeInTheDocument()

    resolveSignOut()

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?', exact: true })).not.toBeInTheDocument()
  })
})
