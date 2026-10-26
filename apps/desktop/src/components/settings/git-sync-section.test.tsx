import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestOpenerService, type TestOpenerService } from '@reflect/app/testing'
import type { OpenerService } from '@reflect/app'
import type { GitSyncState } from '@reflect/core'
import {
  type TestOpenGraph,
  createTestCoreServices,
  createTestGitSyncService,
  createTestGitHostConnector,
  type TestGitSyncService,
  type TestCoreServices,
  type TestGitHostConnector,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { GitSyncSettingsField } from './git-sync-section.tsx'

// The card names the remote and always speaks of sync. One door connects a
// repository on any host; a host remote gets its sign-in here; the GitHub
// account lives under Accounts; an SSH remote's auth error names its own fix.

// The services of the app under test; created fresh for each test.
let opener: TestOpenerService
let gitSync: TestGitSyncService
let gitHostConnector: TestGitHostConnector
let openUrl: MockInstance<OpenerService['openUrl']>

beforeEach(() => {
  opener = createTestOpenerService()
  openUrl = vi.spyOn(opener, 'openUrl')
  gitSync = createTestGitSyncService()
  gitHostConnector = createTestGitHostConnector()
})

async function renderSection(
  state: GitSyncState,
  graph?: TestOpenGraph,
): Promise<TestCoreServices> {
  gitSync.setState(state)
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    gitSync,
    gitHostConnector,
  })
  await renderInApp(<GitSyncSettingsField />, {
    core,
    appServices: { opener },
    graph,
  })
  return core
}

const GITHUB = {
  remoteUrl: 'https://github.com/alex/notes.git',
  remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
} as const

const GITLAB = {
  remoteUrl: 'https://gitlab.com/alex/notes.git',
  remote: { kind: 'https', origin: 'https://gitlab.com' },
} as const

const AUTH_ERROR = {
  state: 'error',
  errorKind: 'auth',
  message: 'the SSH agent offered no key this host accepts — `ssh-add` the right key',
} as const

const ICLOUD_GRAPH: TestOpenGraph = {
  root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
  name: 'Notes',
}

describe('GitSyncSettingsField', () => {
  it('connects a repository through one door: GitHub by default', async () => {
    await renderSection({ phase: 'disconnected' })

    await expect.element(page.locate('legend').getByText('Git repository')).toBeVisible()
    await expect.element(page.getByText(/Sync this graph with your other devices/)).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /Sign out of GitHub/ }))
      .not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Connect a repository…' }))

    await expect.element(page.getByRole('heading', { name: 'Connect a repository' })).toBeVisible()
    await expect.element(page.getByRole('radio', { name: /GitHub/ })).toBeChecked()
    await userEvent.click(page.getByRole('button', { name: 'Continue' }))

    await expect.element(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible()
  })

  it('opens the Other host form from the chooser', async () => {
    await renderSection({ phase: 'disconnected' })

    await userEvent.click(page.getByRole('button', { name: 'Connect a repository…' }))
    await userEvent.click(page.getByRole('radio', { name: /Other host/ }))
    await userEvent.click(page.getByRole('button', { name: 'Continue' }))

    await expect.element(page.getByRole('heading', { name: 'Other host' })).toBeVisible()
    await expect.element(page.getByLabelText('Repository address')).toHaveValue('')
  })

  it('explains the quiet window on a disconnected iCloud graph', async () => {
    await renderSection({ phase: 'disconnected' }, ICLOUD_GRAPH)
    await expect.element(page.getByText(/This graph syncs through iCloud Drive/)).toBeVisible()
  })

  it('describes the history role when iCloud is the channel', async () => {
    await renderSection(
      { phase: 'connected', ...GITHUB, isPrimaryChannel: false, status: { state: 'idle' } },
      ICLOUD_GRAPH,
    )
    await expect
      .element(page.getByText(/Syncs this graph’s history to the repository five minutes/))
      .toBeVisible()
    await expect.element(page.getByText('Up to date')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Save history now' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
  })

  it('names a connected GitHub repository and offers its actions', async () => {
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'idle' },
    })
    await expect.element(page.getByText(/Syncs this graph with your other devices/)).toBeVisible()
    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText('Up to date')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Sync now' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Open on GitHub' })).toBeVisible()
  })

  it('shows the waiting countdown', async () => {
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'waiting', until: 2 * 60_000 + 1 },
    })
    await expect.element(page.getByText('Syncs in 2 minutes')).toBeVisible()
  })

  it('counts the waiting countdown down as time passes', async () => {
    const core = await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'waiting', until: 3 * 60_000 },
    })
    await expect.element(page.getByText('Syncs in 3 minutes')).toBeVisible()
    await core.clock.advance(60_000)
    await expect.element(page.getByText('Syncs in 2 minutes')).toBeVisible()
  })

  it('names an SSH remote and keeps the engine’s own auth message', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      remote: { kind: 'ssh', host: 'gitlab.com' },
      isPrimaryChannel: true,
      status: AUTH_ERROR,
    })

    await expect.element(page.getByText('git@gitlab.com:alex/notes.git')).toBeVisible()
    // The actionable message, not a GitHub sign-in that can't help.
    await expect.element(page.getByText(/Sync failed: .*ssh-add/)).toBeVisible()
    await expect.element(page.getByText(/GitHub/)).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Update sign-in…' }))
      .not.toBeInTheDocument()
  })

  it('names a GitHub remote with a bad sign-in without a reconnect of its own', async () => {
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: AUTH_ERROR,
    })

    await expect
      .element(
        page.getByText('Sync failed: GitHub rejected the sign-in. Sign in again under Accounts.'),
      )
      .toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Open on GitHub' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /Sign out of GitHub/ }))
      .not.toBeInTheDocument()
  })

  it('offers to update the sign-in of a host remote that was refused', async () => {
    await renderSection({
      phase: 'connected',
      ...GITLAB,
      isPrimaryChannel: true,
      status: { state: 'error', errorKind: 'auth', message: 'the host rejected the sign-in' },
    })

    await expect.element(page.getByText('gitlab.com/alex/notes')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Update sign-in…' }))

    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect.element(page.getByLabelText('Repository address')).toHaveValue(GITLAB.remoteUrl)
  })

  it('points a GitHub remote that waits for its sign-in at Accounts', async () => {
    await renderSection({ phase: 'needsCredential', ...GITHUB })

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText('Sign-in needed')).toBeVisible()
    await expect.element(page.getByText(/Sign in under Accounts to resume/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
    // Not the connect door: the remote is already there.
    await expect
      .element(page.getByRole('button', { name: 'Connect a repository…' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Add sign-in…' })).not.toBeInTheDocument()
  })

  it('adds the sign-in of a host remote that waits for it', async () => {
    await renderSection({ phase: 'needsCredential', ...GITLAB })

    await expect.element(page.getByText('gitlab.com/alex/notes')).toBeVisible()
    await expect
      .element(page.getByText('gitlab.com needs a username and an access token or password.'))
      .toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Add sign-in…' }))

    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect.element(page.getByLabelText('Repository address')).toHaveValue(GITLAB.remoteUrl)
    await expect.element(page.getByLabelText('Repository address')).toHaveAttribute('readonly')
    await userEvent.fill(page.getByLabelText('Username'), 'alex')
    await userEvent.fill(page.getByLabelText('Access token or password'), 'glpat-1')
    await userEvent.click(page.getByRole('button', { name: 'Update sign-in', exact: true }))

    await vi.waitFor(() => {
      expect(gitHostConnector.calls()).toEqual([
        { method: 'updateGitHostSignIn', username: 'alex', token: 'glpat-1' },
      ])
    })
  })

  it('names a plain-HTTP remote without its user info and offers no sign-in', async () => {
    await renderSection({
      phase: 'needsCredential',
      remoteUrl: 'http://alex:s3cret@gitea.local/alex/notes.git',
      remote: { kind: 'https', origin: 'http://gitea.local' },
    })

    await expect.element(page.getByText('gitea.local/alex/notes')).toBeVisible()
    await expect.element(page.getByText(/s3cret/)).not.toBeInTheDocument()
    await expect.element(page.getByText(/does not send sign-ins over plain http/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Add sign-in…' })).not.toBeInTheDocument()
  })

  it('opens the connected GitHub repository', async () => {
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open on GitHub' }))

    expect(openUrl).toHaveBeenCalledWith('https://github.com/alex/notes')
  })

  it('clears stale open-repo errors before retrying', async () => {
    openUrl.mockRejectedValueOnce(new Error('No browser'))
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open on GitHub' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Open on GitHub' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
  })

  it('ignores an older open-repo failure after a newer retry succeeds', async () => {
    let rejectFirstOpen: (reason?: unknown) => void = () => {}
    openUrl
      .mockImplementationOnce(() => {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstOpen = reject
        })
      })
      .mockResolvedValueOnce()
    await renderSection({
      phase: 'connected',
      ...GITHUB,
      isPrimaryChannel: true,
      status: { state: 'idle' },
    })

    await userEvent.click(page.getByRole('button', { name: 'Open on GitHub' }))
    await userEvent.click(page.getByRole('button', { name: 'Open on GitHub' }))

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))

    rejectFirstOpen(new Error('Old failure'))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
  })
})
