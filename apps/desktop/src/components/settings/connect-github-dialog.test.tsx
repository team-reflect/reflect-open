import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  cleanup()
  setBridge(null)
  // Reset (not just clear): a failed test must not leak queued one-shot
  // implementations into its neighbors. Defaults are re-applied above.
  vi.resetAllMocks()
})

function renderWizard(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  render(<ConnectGithubDialog suggestedRepoName="g-backup" onClose={onClose} />)
  return onClose
}

describe('ConnectGithubDialog', () => {
  it('connects a freshly API-created repo under the signed-in owner and closes', async () => {
    // First lookup: the repo doesn't exist yet → the dialog API-creates it.
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = renderWizard()

    fireEvent.change(screen.getByLabelText('New repository name'), {
      target: { value: '  my-notes  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // The owner is the verified sign-in — never typed.
    await waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenCalledWith(
        { owner: 'alex', name: 'my-notes' },
        { allowPublic: false },
      ),
    )
    await waitFor(() => expect(sync.connectNewRepo).toHaveBeenCalledWith('my-notes'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the signed-in identity on the finish step', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('alex')).toBeTruthy()
  })

  it('guides through github.com/new when the token cannot create repos', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // The guide names the exact repo and opens the prefilled create page.
    expect(await screen.findByText(/can’t create repositories/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create on GitHub…' }))
    expect(openedUrls).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/new?name=g-backup'),
    )

    // After the handoff, connecting finds the repo and finishes.
    fireEvent.click(screen.getByRole('button', { name: 'I created it — connect' }))
    await waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'g-backup' },
        { allowPublic: false },
      ),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('drops a stale create guide when the wizard takes a different path', async () => {
    // Reach the manual-create guide, detour through the public-repo consent
    // screen and back to the repo step — the old "can't create repositories"
    // panel must not resurface during the new attempt.
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = renderWizard()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/can’t create repositories/i)).toBeTruthy()

    // "I created it" turns up a public repo → consent → choose another.
    sync.connectExistingRepo.mockResolvedValueOnce('needsPublicConfirm')
    fireEvent.click(screen.getByRole('button', { name: 'I created it — connect' }))
    expect(await screen.findByText(/is public/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose another repo' }))

    // New attempt with an existing repo; hold it pending to observe the UI.
    const gate: { resolve: ((value: ConnectExistingResult) => void) | null } = { resolve: null }
    sync.connectExistingRepo.mockImplementationOnce(
      () => new Promise<ConnectExistingResult>((resolve) => (gate.resolve = resolve)),
    )
    fireEvent.click(await screen.findByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/other-notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Connecting…')).toBeTruthy()
    expect(screen.queryByText(/can’t create repositories/i)).toBeNull()

    gate.resolve?.('connected')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('validates the existing-repo input before any network work', async () => {
    renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'not a repo!' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText('Enter the repository as owner/name or a GitHub URL.'),
    ).toBeTruthy()
    expect(sync.connectExistingRepo).not.toHaveBeenCalled()
  })

  it('walks the public-repo consent flow before connecting', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('needsPublicConfirm')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/public-notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // The consent screen names the repo and spells out the stakes.
    expect(await screen.findByText(/alex\/public-notes is public/i)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Back up to a public repo' }))

    await waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'public-notes' },
        { allowPublic: true },
      ),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a missing existing repo as an inline error, not a create guide', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/gone' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/was not found/i)).toBeTruthy()
    expect(sync.connectNewRepo).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // PAT remedy is token scope — the app-install flow is someone else's fix.
    expect(screen.queryByRole('button', { name: /grant access/i })).toBeNull()
  })

  it('offers a way back to change the repository after a failed connect', async () => {
    // A finish-step failure must never trap the user: the only alternative
    // would be closing the whole dialog and starting over.
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/gone' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/was not found/i)).toBeTruthy()

    // Back, fix the name — the stored sign-in carries the retry through.
    fireEvent.click(screen.getByRole('button', { name: 'Change repository' }))
    fireEvent.change(await screen.findByLabelText('Existing repository'), {
      target: { value: 'alex/notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'notes' },
        { allowPublic: false },
      ),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces the create URL when the browser cannot be opened', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    openedUrls.mockRejectedValueOnce(new Error('no handler for https'))
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create on GitHub…' }))

    // The handoff URL is the whole recovery — it must be readable, not lost
    // in a silently rejected promise.
    expect(await screen.findByText(/open the browser/i)).toBeTruthy()
    expect(screen.getByText(/github\.com\/new\?name=g-backup/)).toBeTruthy()
  })

  it('routes an app sign-in that cannot see the repo to the install flow', async () => {
    // GitHub's 404 can't distinguish "doesn't exist" from "no access", and
    // for app sign-ins it's almost always the latter — so granting access
    // is the remedy, with no token language anywhere.
    storeCredential(appCredential())
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/grant it access on GitHub/i)).toBeTruthy()
    expect(screen.queryByText(/token/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Grant access on GitHub…' }))
    expect(openedUrls).toHaveBeenCalledWith(
      'https://github.com/apps/reflect-github-app/installations/new',
    )

    // Back from the browser with access granted: the retry connects.
    fireEvent.click(screen.getByRole('button', { name: 'I granted it — try again' }))
    await waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenLastCalledWith(
        { owner: 'alex', name: 'notes' },
        { allowPublic: false },
      ),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('points the app create guide at granting access, not token scope', async () => {
    storeCredential(appCredential())
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/Reflect can’t create the repository itself/i)).toBeTruthy()
    expect(screen.queryByText(/token/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /grant the Reflect app access/i }))
    expect(openedUrls).toHaveBeenCalledWith(
      'https://github.com/apps/reflect-github-app/installations/new',
    )
  })

  it('promotes the grant remedy when a created repo still cannot be seen', async () => {
    // App user, "selected repositories" install: they create the repo via
    // the handoff, but the app was never granted access to it. After
    // "I created it — connect" a 404 means visibility, not existence — the
    // grant flow takes over instead of looping back into the create guide.
    storeCredential(appCredential())
    sync.connectExistingRepo.mockResolvedValueOnce('notFound').mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    const onClose = renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'I created it — connect' }))

    expect(await screen.findByText(/still can’t see the new repository/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create on GitHub…' })).toBeNull()
    // The repo exists now — re-running the API create would just 422.
    expect(sync.connectNewRepo).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Grant access on GitHub…' }))
    expect(openedUrls).toHaveBeenCalledWith(
      'https://github.com/apps/reflect-github-app/installations/new',
    )

    fireEvent.click(screen.getByRole('button', { name: 'I granted it — try again' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps the created-but-unseen remedy token-flavored for PAT users', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound').mockResolvedValueOnce('notFound')
    sync.connectNewRepo.mockResolvedValueOnce('manualCreateNeeded')
    renderWizard()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'I created it — connect' }))

    expect(await screen.findByText(/included in your token’s repository access/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /grant access/i })).toBeNull()
  })
})
