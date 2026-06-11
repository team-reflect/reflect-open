import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { open } from '@tauri-apps/plugin-dialog'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { RestoreFromGithubDialog } from './restore-from-github-dialog'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

const openRecent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => ({ openRecent }) }))

let cloned: Array<Record<string, unknown>>

beforeEach(() => {
  cloned = []
  setBridge({
    invoke: async (command, args) => {
      if (command === 'secret_get') {
        // A stored credential skips the auth step straight to the repo step.
        return JSON.stringify({ kind: 'pat', token: 'ghp_abc' })
      }
      if (command === 'git_clone') {
        cloned.push(args)
        return null
      }
      return null
    },
    listen: async () => () => {},
  })
  // GET /user accepts the stored token and identifies the account.
  httpFetch.mockResolvedValue(
    new Response(JSON.stringify({ login: 'alex' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
})

afterEach(() => {
  cleanup()
  setBridge(null)
  vi.clearAllMocks()
})

async function renderRepoStep(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  render(<RestoreFromGithubDialog onClose={onClose} />)
  await waitFor(() => {
    expect(screen.getByLabelText('Backup repository')).toBeTruthy()
  })
  return onClose
}

describe('RestoreFromGithubDialog', () => {
  it('validates the repo input and the destination before cloning', async () => {
    await renderRepoStep()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(
      await screen.findByText('Enter the repository name (or owner/name for another account).'),
    ).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Backup repository'), {
      target: { value: 'alex/notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('Choose a folder to restore into.')).toBeTruthy()
    expect(cloned).toEqual([])
  })

  it('rejects an invalid bare repo name instead of failing at the clone', async () => {
    vi.mocked(open).mockResolvedValue('/backups')
    await renderRepoStep()

    fireEvent.change(screen.getByLabelText('Backup repository'), {
      target: { value: 'my notes!' }, // bare, but not a legal repo name
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore into…' }))
    await screen.findByText('/backups')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    expect(
      await screen.findByText('Enter the repository name (or owner/name for another account).'),
    ).toBeTruthy()
    expect(cloned).toEqual([])
  })

  it('defaults a bare repo name to the signed-in account', async () => {
    vi.mocked(open).mockResolvedValue('/backups')
    await renderRepoStep()

    fireEvent.change(screen.getByLabelText('Backup repository'), {
      target: { value: 'notes' }, // no owner typed — it's the user's own
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore into…' }))
    await screen.findByText('/backups')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() =>
      expect(cloned).toEqual([
        {
          url: 'https://github.com/alex/notes.git',
          path: '/backups/notes',
          token: 'ghp_abc',
        },
      ]),
    )
  })

  it('clones into <folder>/<repo> and opens the result as a graph', async () => {
    vi.mocked(open).mockResolvedValue('/backups')
    const onClose = await renderRepoStep()

    fireEvent.change(screen.getByLabelText('Backup repository'), {
      target: { value: 'alex/notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore into…' }))
    await screen.findByText('/backups')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() =>
      expect(cloned).toEqual([
        {
          url: 'https://github.com/alex/notes.git',
          path: '/backups/notes',
          token: 'ghp_abc',
        },
      ]),
    )
    expect(openRecent).toHaveBeenCalledWith('/backups/notes')
    expect(onClose).toHaveBeenCalled()
  })
})
