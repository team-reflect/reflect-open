import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestOpenerService, type TestOpenerService } from '@reflect/app/testing'
import type { OpenerService } from '@reflect/app'
import type { BackupService, BackupState } from '@reflect/core'
import {
  type TestOpenGraph,
  createTestCoreServices,
  createTestBackupService,
  type TestBackupService,
  type TestCoreServices,
} from '@reflect/core/testing'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { BackupSettingsField } from './backup-section.tsx'

// The section's GitHub-vs-generic split (Plan 16): a hand-wired remote must
// render host-neutrally, and its auth errors must surface the engine's
// actionable message — "reconnect GitHub" can't fix an ssh-agent problem.

// Whether a GitHub credential is stored; each test sets it before `renderSection`.
let githubConnected: boolean

// The services of the app under test; created fresh for each test.
let opener: TestOpenerService
let backup: TestBackupService
let openUrl: MockInstance<OpenerService['openUrl']>
let signOut: MockInstance<BackupService['signOut']>

beforeEach(() => {
  githubConnected = false
  opener = createTestOpenerService()
  openUrl = vi.spyOn(opener, 'openUrl')
  backup = createTestBackupService()
  signOut = vi.spyOn(backup, 'signOut')
})

async function renderSection(state: BackupState, graph?: TestOpenGraph): Promise<TestCoreServices> {
  backup.setState(state)
  const app = createTestCoreServices({ database: createWasmTestDatabaseService(), backup })
  if (githubConnected) {
    await app.githubAuth.save({ kind: 'pat', token: 'ghp_test' })
  }
  await renderInApp(<BackupSettingsField />, {
    app,
    appServices: { opener },
    graph,
  })
  return app
}

const AUTH_ERROR = {
  state: 'error',
  errorKind: 'auth',
  message: 'the SSH agent offered no key this host accepts — `ssh-add` the right key',
} as const

const ICLOUD_GRAPH: TestOpenGraph = {
  root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
  name: 'Notes',
}

describe('BackupSettingsField', () => {
  it('explains the quiet window on an iCloud graph', async () => {
    await renderSection({ phase: 'disconnected' }, ICLOUD_GRAPH)
    await expect
      .element(page.getByText(/This graph already syncs through iCloud Drive/))
      .toBeVisible()
  })

  it('describes the quiet window when an iCloud graph is connected', async () => {
    await renderSection(
      {
        phase: 'connected',
        remoteUrl: 'https://github.com/alex/notes.git',
        repo: { owner: 'alex', name: 'notes' },
        status: { state: 'idle' },
      },
      ICLOUD_GRAPH,
    )
    await expect
      .element(
        page.getByText(/Backs up to GitHub five minutes after iCloud and your edits go quiet/),
      )
      .toBeVisible()
  })

  it('shows the waiting countdown', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'waiting', until: 2 * 60_000 + 1 },
    })
    await expect.element(page.getByText('Backs up in 2 minutes')).toBeVisible()
  })

  it('counts the waiting countdown down as time passes', async () => {
    const app = await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'waiting', until: 3 * 60_000 },
    })
    await expect.element(page.getByText('Backs up in 3 minutes')).toBeVisible()
    await app.clock.advance(60_000)
    await expect.element(page.getByText('Backs up in 2 minutes')).toBeVisible()
  })

  it('names no host for an iCloud graph with a generic remote', async () => {
    await renderSection(
      {
        phase: 'connected',
        remoteUrl: 'git@gitlab.com:alex/notes.git',
        repo: null,
        status: { state: 'idle' },
      },
      ICLOUD_GRAPH,
    )
    await expect
      .element(page.getByText(/Pushes to the backup five minutes after iCloud/))
      .toBeVisible()
    await expect.element(page.getByText(/GitHub/)).not.toBeInTheDocument()
  })

  it('renders a generic remote host-neutrally with the engine’s own auth message', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      repo: null,
      status: AUTH_ERROR,
    })

    await expect.element(page.locate('legend').getByText('Backup')).toBeVisible()
    await expect.element(page.getByText('GitHub sync')).not.toBeInTheDocument()
    await expect.element(page.getByText('git@gitlab.com:alex/notes.git')).toBeVisible()
    // The actionable message, not a GitHub reconnect that can't help.
    await expect.element(page.getByText(/ssh-add/)).toBeVisible()
    await expect.element(page.getByText(/reconnect GitHub/)).not.toBeInTheDocument()
    // Machine-level GitHub sign-out is noise next to a non-GitHub graph.
    await expect
      .element(page.getByRole('button', { name: /Sign out of GitHub/ }))
      .not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Open GitHub repo' }))
      .not.toBeInTheDocument()
  })

  it('renders a GitHub remote with the reconnect affordances', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: AUTH_ERROR,
    })

    await expect.element(page.getByText('GitHub sync')).toBeVisible()
    await expect.element(page.getByText('alex/notes')).toBeVisible()
    await expect.element(page.getByText(/reconnect GitHub/)).toBeVisible()
    await expect.element(page.getByText('GitHub account')).toBeVisible()
    await expect.element(page.getByText(/connected graphs stop backing up/i)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Open GitHub repo' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Sign out of GitHub/ })).toBeVisible()
  })

  it('opens the connected GitHub repository', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    expect(openUrl).toHaveBeenCalledWith('https://github.com/alex/notes')
  })

  it('keeps unrelated action errors out of the sign-out dialog', async () => {
    openUrl.mockRejectedValueOnce(new Error('No browser'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))

    await expect
      .element(page.getByRole('dialog').getByText(/Couldn’t open the browser/))
      .not.toBeInTheDocument()
  })

  it('clears stale open-repo errors before retrying', async () => {
    openUrl.mockRejectedValueOnce(new Error('No browser'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
  })

  it('ignores an older open-repo failure after a newer retry succeeds', async () => {
    let rejectFirstOpen: (reason?: unknown) => void = () => {}
    openUrl
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

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))
    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

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

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()
    await expect
      .element(page.getByText(/Every GitHub-backed graph will stop backing up/i))
      .toBeVisible()
    expect(signOut).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    await expect
      .element(page.getByRole('heading', { name: 'Sign out of GitHub?' }))
      .not.toBeInTheDocument()
  })

  it('shows sign-out failures inside the confirmation dialog', async () => {
    signOut.mockRejectedValueOnce(new Error('Keychain denied'))
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()
    await expect.element(page.getByRole('dialog').getByText('Keychain denied')).toBeVisible()
    await expectLocatorToHaveCount(page.getByText('Keychain denied'), 1)
  })

  it('does not close the sign-out dialog while sign-out is pending', async () => {
    const pendingSignOut = Promise.withResolvers<void>()
    signOut.mockImplementationOnce(() => pendingSignOut.promise)
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://github.com/alex/notes.git',
      repo: { owner: 'alex', name: 'notes' },
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()

    pendingSignOut.resolve()

    await expect
      .element(page.getByRole('heading', { name: 'Sign out of GitHub?' }))
      .not.toBeInTheDocument()
  })

  it('offers sign-out with no connected graph when signed in to GitHub', async () => {
    githubConnected = true
    await renderSection({ phase: 'disconnected' })

    await expect.element(page.getByRole('button', { name: /Connect GitHub/ })).toBeVisible()
    await expect.element(page.getByText('GitHub account')).toBeVisible()
    await expect.element(page.getByText(/Sign out to connect a different account/i)).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Sign out of GitHub/ })).toBeVisible()
  })

  it('hides sign-out with no connected graph when not signed in to GitHub', async () => {
    githubConnected = false
    await renderSection({ phase: 'disconnected' })

    await expect.element(page.getByRole('button', { name: /Connect GitHub/ })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /Sign out of GitHub/ }))
      .not.toBeInTheDocument()
  })

  it('signs out of GitHub from the disconnected state', async () => {
    githubConnected = true
    await renderSection({ phase: 'disconnected' })

    await userEvent.click(page.getByRole('button', { name: /Sign out of GitHub/ }))
    await expect.element(page.getByRole('heading', { name: 'Sign out of GitHub?' })).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Sign out' }))

    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
  })
})
