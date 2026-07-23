import type { ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { ConnectExistingResult } from '@/lib/backup-controller'
import { fireEvent } from '@/test-utils/fire-event'
import { ConnectGithubDrawer } from './connect-github-drawer'

/**
 * The mobile connect sheet. The wizard's flow branches (create handoff,
 * grant access, public consent, error escapes) are specified against the
 * shared hook by connect-github-dialog.test.tsx; this suite covers what is
 * the drawer's own: the fixed suggested name (never the graph's), the
 * open/close lifecycle, and a fresh wizard per open.
 */

// Keep the sheet content inline so this suite can focus on the wizard state.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const sync = vi.hoisted(() => ({
  connectNewRepo: vi.fn(async (): Promise<'connected' | 'manualCreateNeeded'> => 'connected'),
  connectExistingRepo: vi.fn(async (): Promise<ConnectExistingResult> => 'connected'),
}))
vi.mock('@/providers/sync-provider', () => ({ useSync: () => sync }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

beforeEach(() => {
  // A stored PAT + GitHub accepting it ("alex") makes the auth step skip
  // itself, so a Continue lands straight on the finish step.
  setBridge({
    invoke: async (command) =>
      command === 'secret_get' ? JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) : null,
    listen: async () => () => {},
  })
  httpFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ login: 'alex' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  sync.connectNewRepo.mockResolvedValue('connected')
  sync.connectExistingRepo.mockResolvedValue('connected')
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  vi.resetAllMocks()
})

describe('ConnectGithubDrawer', () => {
  it('suggests reflect-backup — never the local graph name — and connects', async () => {
    sync.connectExistingRepo.mockResolvedValueOnce('notFound')
    const onOpenChange = vi.fn()
    await render(<ConnectGithubDrawer open onOpenChange={onOpenChange} pollIntervalMs={15} />)

    // The local graph's display name is the sandbox folder ("Documents") —
    // the prefill must be the fixed fallback, not a graph-derived slug.
    await expect
      .element(page.getByLabelText('Repository name'))
      .toHaveValue('reflect-backup')
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenCalledWith(
        { owner: 'alex', name: 'reflect-backup' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(sync.connectNewRepo).toHaveBeenCalledWith('reflect-backup'))
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('connects an existing repository and closes the sheet', async () => {
    const onOpenChange = vi.fn()
    await render(<ConnectGithubDrawer open onOpenChange={onOpenChange} pollIntervalMs={15} />)

    await page.getByRole('radio', { name: /use an existing repository/i }).click()
    fireEvent.change(page.getByPlaceholder('owner/name'), {
      target: { value: 'alex/notes' },
    })
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() =>
      expect(sync.connectExistingRepo).toHaveBeenCalledWith(
        { owner: 'alex', name: 'notes' },
        { allowPublic: false },
      ),
    )
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('starts a fresh wizard on every open', async () => {
    const onOpenChange = vi.fn()
    const view = await render(<ConnectGithubDrawer open onOpenChange={onOpenChange} />)

    // Leave the wizard mid-flow with a validation error showing.
    await page.getByRole('radio', { name: /use an existing repository/i }).click()
    fireEvent.change(page.getByPlaceholder('owner/name'), {
      target: { value: 'not a repo!' },
    })
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect
      .element(page.getByText('Enter the repository as owner/name or a GitHub URL.'))
      .toBeVisible()

    // Close: the body unmounts entirely (which also stops any polls).
    await view.rerender(<ConnectGithubDrawer open={false} onOpenChange={onOpenChange} />)
    await expect
      .element(page.getByRole('button', { name: 'Continue' }))
      .not.toBeInTheDocument()

    // Reopen: back to the repo step defaults, no leaked error or mode.
    await view.rerender(<ConnectGithubDrawer open onOpenChange={onOpenChange} />)
    await expect
      .element(page.getByRole('radio', { name: /create a new private repository/i }))
      .toBeChecked()
    await expect
      .element(page.getByLabelText('Repository name'))
      .toHaveValue('reflect-backup')
    await expect
      .element(page.getByText('Enter the repository as owner/name or a GitHub URL.'))
      .not.toBeInTheDocument()
  })
})
