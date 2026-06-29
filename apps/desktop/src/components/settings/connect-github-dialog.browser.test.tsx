import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ConnectExistingResult } from '@/lib/backup-controller'
import { ConnectGithubDialog } from './connect-github-dialog'

const sync = vi.hoisted(() => ({
  connectNewRepo: vi.fn(async (): Promise<'connected' | 'manualCreateNeeded'> => 'connected'),
  connectExistingRepo: vi.fn(async (): Promise<ConnectExistingResult> => 'connected'),
}))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)
const openedUrls = vi.mocked(openUrl)

/** A keychain holding the given credential; GET /user accepting it makes the auth step skip itself. */
function storeCredential(auth: Record<string, unknown>): void {
  setBridge({
    invoke: async (command) => (command === 'secret_get' ? JSON.stringify(auth) : null),
    listen: async () => () => {},
  })
}

/** A device-flow (GitHub App) credential with a comfortably unexpired token. */
function appCredential(): Record<string, unknown> {
  return {
    kind: 'app',
    accessToken: 'ghu_live',
    refreshToken: 'ghr_live',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
}

beforeEach(() => {
  // A stored credential + GitHub accepting it ("alex") makes the auth step
  // skip itself, so a Continue lands straight on the finish step. PAT by
  // default; app-credential tests re-store before rendering.
  storeCredential({ kind: 'pat', token: 'ghp_abc' })
  // A fresh Response per call — bodies are single-use, and a wizard run can
  // pass through the auth step more than once.
  httpFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ login: 'alex' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  sync.connectNewRepo.mockResolvedValue('connected')
  sync.connectExistingRepo.mockResolvedValue('connected')
  openedUrls.mockResolvedValue(undefined)
})

afterEach(() => {
  setBridge(null)
  // Reset (not just clear): a failed test must not leak queued one-shot
  // implementations into its neighbors. Defaults are re-applied above.
  vi.resetAllMocks()
})

async function renderWizard(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  await render(
    <ConnectGithubDialog suggestedRepoName="g-backup" onClose={onClose} pollIntervalMs={15} />,
  )
  return onClose
}

describe('ConnectGithubDialog', () => {
  it('connects a freshly API-created repo under the signed-in owner and closes', async () => {
    // First lookup: the repo doesn't exist yet → the dialog API-creates it.
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = await renderWizard()

    await userEvent.fill(page.getByLabelText('New repository name', { exact: true }), '  my-notes  ')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    // The owner is the verified sign-in — never typed.
    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenCalledWith(
        { owner: 'alex', name: 'my-notes' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(sync.connectNewRepo).toHaveBeenCalledWith('my-notes'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows the signed-in identity on the finish step', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText('alex', { exact: true })).toBeInTheDocument()
  })

  it('hands off to github.com/new and connects by polling — no button to click', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound').mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    // The guide names the exact repo and opens the prefilled create page.
    await expect.element(page.getByText(/waiting for the repository/i)).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Create on GitHub…', exact: true }))
    expect(openedUrls).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/new?name=g-backup'),
    )

    // Once the repo exists, a poll connects it — the user clicks nothing.
    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'g-backup' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    // The repo exists now — re-running the API create would just 422.
    expect(sync.connectNewRepo).toHaveBeenCalledTimes(1)
  })

  it('stops polling for consent when the created repo turns out public', async () => {
    sync.connectExistingRepo
      .mockResolvedValueOnce('notFound') // initial lookup → create guide
      .mockResolvedValueOnce('needsPublicConfirm') // first poll finds it public
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = await renderWizard()
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText(/is public/i)).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Choose another repo', exact: true }))

    // New attempt with an existing repo; hold it pending to observe the UI —
    // the stale create guide (and its poll) must not resurface.
    const gate: { resolve: ((value: ConnectExistingResult) => void) | null } = { resolve: null }
    sync.connectExistingRepo.mockImplementationOnce(
      () => new Promise<ConnectExistingResult>((resolve) => (gate.resolve = resolve)),
    )
    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/other-notes')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText('Connecting…', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText(/waiting for the repository/i)).not.toBeInTheDocument()

    gate.resolve?.('connected')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('lets the user back out of the create guide', async () => {
    sync.connectExistingRepo.mockResolvedValue('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))
    await userEvent.click(page.getByRole('button', { name: 'Change repository', exact: true }))

    await expect.element(page.getByLabelText('New repository name', { exact: true })).toBeInTheDocument()
  })

  it('validates the existing-repo input before any network work', async () => {
    await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'not a repo!')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect
      .element(page.getByText('Enter the repository as owner/name or a GitHub URL.', { exact: true }))
      .toBeInTheDocument()
    expect(sync.connectExistingRepo).not.toHaveBeenCalled()
  })

  it('walks the public-repo consent flow before connecting', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('needsPublicConfirm')
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/public-notes')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    // The consent screen names the repo and spells out the stakes.
    await expect.element(page.getByText(/alex\/public-notes is public/i)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Back up to a public repo', exact: true }))

    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'public-notes' },
        { allowPublic: true },
      ),
    )
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('surfaces a missing existing repo as an inline error, not a create guide', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/gone')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText(/not found/i)).toBeInTheDocument()
    expect(sync.connectNewRepo).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // PAT remedy is token scope — the app-install flow is someone else's fix.
    await expect.element(page.getByRole('button', { name: /grant access/i })).not.toBeInTheDocument()
  })

  it('offers a way back to change the repository after a failed connect', async () => {
    // A finish-step failure must never trap the user: the only alternative
    // would be closing the whole dialog and starting over.
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/gone')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))
    await expect.element(page.getByText(/not found/i)).toBeInTheDocument()

    // Back, fix the name — the stored sign-in carries the retry through.
    await userEvent.click(page.getByRole('button', { name: 'Change repository', exact: true }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/notes')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'notes' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('surfaces the create URL when the browser cannot be opened', async () => {
    sync.connectExistingRepo.mockResolvedValue('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    openedUrls.mockRejectedValueOnce(new Error('no handler for https'))
    await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))
    await userEvent.click(page.getByRole('button', { name: 'Create on GitHub…', exact: true }))

    // The handoff URL is the whole recovery — it must be readable, not lost
    // in a silently rejected promise.
    await expect.element(page.getByText(/open the browser/i)).toBeInTheDocument()
    await expect.element(page.getByText(/github\.com\/new\?name=g-backup/)).toBeInTheDocument()
  })

  it('routes an app sign-in that cannot see the repo to the grant-access step, then polls', async () => {
    // A GitHub App user token only reaches repos the app is installed on, so a
    // 404 for an app sign-in almost always means "not installed here": granting
    // access is the expected step (not an error), and the poll connects once it
    // lands — no retry button, no token language.
    storeCredential(appCredential())
    sync.connectExistingRepo
      .mockResolvedValueOnce('notFound') // initial lookup: app can't see it yet
      .mockResolvedValueOnce('notFound') // poll: access still not granted
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/notes')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    // A plain "give access" step that names the repo and steers to a per-repo
    // grant (never "All repositories").
    await expect.element(page.getByText(/give reflect access to/i)).toBeInTheDocument()
    await expect.element(page.getByText(/only select repositories/i)).toBeInTheDocument()
    await expect.element(page.getByText(/all repositories/i)).not.toBeInTheDocument()
    await expect.element(page.getByText(/token/i)).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /try again/i })).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Grant access on GitHub…', exact: true }))
    expect(openedUrls).toHaveBeenCalledWith(
      'https://github.com/apps/reflect-github-app/installations/new',
    )

    // Back from the browser with access granted — the poll connects, no click.
    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'notes' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(sync.connectExistingRepo.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('skips the grant-access step when an app sign-in can already see the repo', async () => {
    // A returning user whose install already covers the repo: the first lookup
    // succeeds, so there's no grant-access detour — the dialog just connects.
    storeCredential(appCredential())
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('radio', { name: /use an existing repository/i }))
    await userEvent.fill(page.getByLabelText('Existing repository', { exact: true }), 'alex/notes')
    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    await expect.element(page.getByText(/give reflect access/i)).not.toBeInTheDocument()
  })

  it('points the app create guide at granting access, not token scope', async () => {
    storeCredential(appCredential())
    sync.connectExistingRepo.mockResolvedValue('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await userEvent.click(page.getByRole('button', { name: /grant the Reflect app access/i }))
    expect(openedUrls).toHaveBeenCalledWith(
      'https://github.com/apps/reflect-github-app/installations/new',
    )
    await expect.element(page.getByText(/token/i)).not.toBeInTheDocument()
  })

  it('keeps polling until an app-created repo becomes visible, then connects', async () => {
    // App user, "selected repositories" install: they create the repo via
    // the handoff, but the app gains access to it only when they grant it.
    // The poll rides through the 404s and connects on the first success.
    storeCredential(appCredential())
    sync.connectExistingRepo
      .mockResolvedValueOnce('notFound') // initial lookup
      .mockResolvedValueOnce('notFound') // poll: created, not granted yet
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText(/waiting for the repository/i)).toBeInTheDocument()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(sync.connectExistingRepo.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(sync.connectNewRepo).toHaveBeenCalledTimes(1)
  })

  it('keeps the create-guide hint token-flavored for PAT users', async () => {
    sync.connectExistingRepo.mockResolvedValue('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    await renderWizard()

    await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }))

    await expect.element(page.getByText(/token’s repository access/i)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /grant/i })).not.toBeInTheDocument()
  })
})
