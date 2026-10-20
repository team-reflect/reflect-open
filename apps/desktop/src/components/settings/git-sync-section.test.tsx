import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestOpenerService, type TestOpenerService } from '@reflect/app/testing'
import type { OpenerService } from '@reflect/app'
import type { GitSyncService, GitSyncState } from '@reflect/core'
import {
  type TestOpenGraph,
  createTestCoreServices,
  createTestGitSyncService,
  createTestHostConnector,
  type TestGitSyncService,
  type TestHostConnector,
  type TestCoreServices,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { GitSyncSettingsField } from './git-sync-section.tsx'

// The card speaks of the destination, not of GitHub: a GitLab, SSH or path
// remote renders host-neutrally, and its auth errors surface the engine's own
// message, because "sign in to GitHub again" cannot fix an ssh-agent problem.

// The services of the app under test; created fresh for each test.
let opener: TestOpenerService
let gitSync: TestGitSyncService
let hostConnector: TestHostConnector
let openUrl: MockInstance<OpenerService['openUrl']>
let disconnectGraph: MockInstance<GitSyncService['disconnectGraph']>

beforeEach(() => {
  opener = createTestOpenerService()
  openUrl = vi.spyOn(opener, 'openUrl')
  gitSync = createTestGitSyncService()
  disconnectGraph = vi.spyOn(gitSync, 'disconnectGraph')
  hostConnector = createTestHostConnector()
})

async function renderSection(
  state: GitSyncState,
  graph?: TestOpenGraph,
): Promise<TestCoreServices> {
  gitSync.setState(state)
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    gitSync,
    hostConnector,
  })
  await renderInApp(<GitSyncSettingsField />, {
    app,
    appServices: { opener },
    graph,
  })
  return app
}

const GITHUB: GitSyncState = {
  phase: 'connected',
  remoteUrl: 'https://github.com/alex/notes.git',
  remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
  coexisting: false,
  status: { state: 'idle' },
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

describe('GitSyncSettingsField', () => {
  it('offers GitHub and another host on a folder graph with no remote', async () => {
    await renderSection({ phase: 'disconnected' })

    await expect.element(page.locate('legend').getByText('Git repository')).toBeVisible()
    await expect.element(page.getByText(/Sync this graph with your other devices/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Connect GitHub…' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Another host…' })).toBeVisible()
  })

  it('explains the history role on an iCloud graph with no remote', async () => {
    await renderSection({ phase: 'disconnected' }, ICLOUD_GRAPH)
    await expect
      .element(page.getByText(/This graph syncs through iCloud Drive. A repository adds a history/))
      .toBeVisible()
  })

  it('speaks of sync on a folder graph', async () => {
    await renderSection(GITHUB)
    await expect.element(page.getByText('Up to date')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Sync now' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
    await expect.element(page.getByText(/Syncs this graph with your other devices/)).toBeVisible()
  })

  it('speaks of backup beside iCloud', async () => {
    await renderSection({ ...GITHUB, coexisting: true }, ICLOUD_GRAPH)
    await expect.element(page.getByText('Backed up')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Back up now' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop backing up' })).toBeVisible()
    await expect.element(page.getByText(/updates five minutes after edits go quiet/)).toBeVisible()
  })

  it('shows the waiting countdown and counts it down', async () => {
    const app = await renderSection({
      ...GITHUB,
      status: { state: 'waiting', until: 3 * 60_000 },
    })
    await expect.element(page.getByText('Syncs in 3 minutes')).toBeVisible()
    await app.clock.advance(60_000)
    await expect.element(page.getByText('Syncs in 2 minutes')).toBeVisible()
  })

  it('renders an SSH remote host-neutrally with the engine’s own auth message', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      remote: { kind: 'ssh', host: 'gitlab.com' },
      coexisting: false,
      status: AUTH_ERROR,
    })

    await expect.element(page.getByText('git@gitlab.com:alex/notes.git')).toBeVisible()
    await expect.element(page.getByText(/ssh-add/)).toBeVisible()
    await expect.element(page.getByText(/sign in to GitHub again/)).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Open GitHub repo' }))
      .not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Update sign-in…' }))
      .not.toBeInTheDocument()
  })

  it('points a GitHub auth failure at the account row', async () => {
    await renderSection({ ...GITHUB, status: AUTH_ERROR })

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText(/sign in to GitHub again/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Open GitHub repo' })).toBeVisible()
  })

  it('offers to update the sign-in of a host that refused it', async () => {
    await renderSection({
      phase: 'connected',
      remoteUrl: 'https://gitlab.com/alex/notes.git',
      remote: { kind: 'https', origin: 'https://gitlab.com' },
      coexisting: false,
      status: { state: 'error', errorKind: 'auth', message: 'the host rejected the sign-in' },
    })

    await expect.element(page.getByText('gitlab.com/alex/notes')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Update sign-in…' }))

    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect
      .element(page.getByLabelText('Repository URL'))
      .toHaveValue('https://gitlab.com/alex/notes.git')
  })

  it('names a GitHub remote that waits for the account to sign in', async () => {
    await renderSection({
      phase: 'needsCredential',
      remoteUrl: 'https://github.com/alex/notes.git',
      remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    })

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText('Sign-in needed')).toBeVisible()
    await expect.element(page.getByText(/Sign in to GitHub below/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Add sign-in…' })).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Stop syncing' }))
    await vi.waitFor(() => expect(disconnectGraph).toHaveBeenCalledTimes(1))
  })

  it('offers a sign-in for a host remote that has none', async () => {
    await renderSection({
      phase: 'needsCredential',
      remoteUrl: 'https://gitlab.com/alex/notes.git',
      remote: { kind: 'https', origin: 'https://gitlab.com' },
    })

    await expect.element(page.getByText('gitlab.com/alex/notes')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Add sign-in…' }))
    await expect
      .element(page.getByLabelText('Repository URL'))
      .toHaveValue('https://gitlab.com/alex/notes.git')
  })

  it('connects another host from the dialog and closes it', async () => {
    await renderSection({ phase: 'disconnected' })
    await userEvent.click(page.getByRole('button', { name: 'Another host…' }))
    await expect.element(page.getByRole('heading', { name: 'Connect another host' })).toBeVisible()

    await page.getByLabelText('Repository URL').fill('https://gitlab.com/alex/notes.git')
    await page.getByLabelText('Username').fill('alex')
    await page.getByLabelText('Access token').fill('glpat-1')
    await userEvent.click(page.getByRole('button', { name: 'Connect', exact: true }))

    await vi.waitFor(() => {
      expect(hostConnector.calls()).toEqual([
        { remoteUrl: 'https://gitlab.com/alex/notes.git', username: 'alex', token: 'glpat-1' },
      ])
    })
    await expect
      .element(page.getByRole('heading', { name: 'Connect another host' }))
      .not.toBeInTheDocument()
  })

  it('keeps the host dialog open with the host’s answer when it refuses', async () => {
    hostConnector.onConnectHost(() => Promise.reject(new Error('the host rejected the sign-in')))
    await renderSection({ phase: 'disconnected' })
    await userEvent.click(page.getByRole('button', { name: 'Another host…' }))
    await page.getByLabelText('Repository URL').fill('https://gitlab.com/alex/notes.git')
    await userEvent.click(page.getByRole('button', { name: 'Connect', exact: true }))

    await expect.element(page.getByRole('alert')).toHaveTextContent('the host rejected the sign-in')
    await expect.element(page.getByRole('heading', { name: 'Connect another host' })).toBeVisible()
  })

  it('opens the connected GitHub repository', async () => {
    await renderSection(GITHUB)

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    expect(openUrl).toHaveBeenCalledWith('https://github.com/alex/notes')
  })

  it('clears stale open-repo errors before retrying', async () => {
    openUrl.mockRejectedValueOnce(new Error('No browser'))
    await renderSection(GITHUB)

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    await expect.element(page.getByText(/Couldn’t open the browser/)).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

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
    await renderSection(GITHUB)

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))
    await userEvent.click(page.getByRole('button', { name: 'Open GitHub repo' }))

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2))

    rejectFirstOpen(new Error('Old failure'))

    await expect.element(page.getByText(/Couldn’t open the browser/)).not.toBeInTheDocument()
  })
})
