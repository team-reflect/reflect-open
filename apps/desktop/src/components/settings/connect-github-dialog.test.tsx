import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { ConnectExistingResult } from '@/lib/backup-controller'
import { ConnectGithubDialog } from './connect-github-dialog'

const sync = vi.hoisted(() => ({
  connectNewRepo: vi.fn(async () => {}),
  connectExistingRepo: vi.fn(async (): Promise<ConnectExistingResult> => 'connected'),
}))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))

beforeEach(() => {
  // A stored credential makes the auth step skip straight to the repo step.
  setBridge({
    invoke: async (command) =>
      command === 'secret_get' ? JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) : null,
    listen: async () => () => {},
  })
})

afterEach(() => {
  cleanup()
  setBridge(null)
  vi.clearAllMocks()
})

async function renderRepoStep(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  render(<ConnectGithubDialog suggestedRepoName="g-backup" onClose={onClose} />)
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: /create a new private repository/i })).toBeTruthy()
  })
  return onClose
}

describe('ConnectGithubDialog', () => {
  it('creates a new private repo with the (trimmed) typed name and closes', async () => {
    const onClose = await renderRepoStep()

    fireEvent.change(screen.getByLabelText('New repository name'), {
      target: { value: '  my-notes  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(sync.connectNewRepo).toHaveBeenCalledWith('my-notes'))
    expect(onClose).toHaveBeenCalled()
  })

  it('validates the existing-repo input before any network work', async () => {
    await renderRepoStep()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'not a repo!' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(
      await screen.findByText('Enter the repository as owner/name or a GitHub URL.'),
    ).toBeTruthy()
    expect(sync.connectExistingRepo).not.toHaveBeenCalled()
  })

  it('walks the public-repo consent flow before connecting', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('needsPublicConfirm')
    const onClose = await renderRepoStep()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/public-notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

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

  it('surfaces a missing repo as an inline error, not a crash', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onClose = await renderRepoStep()

    fireEvent.click(screen.getByRole('radio', { name: /use an existing repository/i }))
    fireEvent.change(screen.getByLabelText('Existing repository'), {
      target: { value: 'alex/gone' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/was not found/i)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
