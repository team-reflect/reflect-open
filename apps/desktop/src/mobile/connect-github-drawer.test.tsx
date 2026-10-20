import type { ReactNode } from 'react'
import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { CoreServices } from '@reflect/core'
import {
  createTestCoreServices,
  createTestHttpService,
  createTestPlatformService,
  createTestGitSyncService,
  createTestGithubConnector,
  createTestSecretStoreService,
  type TestGithubConnector,
} from '@reflect/core/testing'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ConnectGithubDrawer } from './connect-github-drawer.tsx'

/**
 * The mobile connect sheet. The wizard's flow branches (create handoff,
 * grant access, public consent, error escapes) are specified against the
 * shared hook by connect-github-dialog.test.tsx; this suite covers what is
 * the drawer's own: the fixed suggested name (never the graph's), the
 * open/close lifecycle, and a fresh wizard per open.
 */

// Keep the sheet content inline so this suite can focus on the wizard state.
vi.mock('@/components/ui/drawer.tsx', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

/**
 * Render the sheet over a scripted backup, which connects every repository
 * unless `script` says otherwise.
 */
async function mount(
  ui: ReactNode,
  script?: (connector: TestGithubConnector) => void,
): Promise<InAppRenderResult<CoreServices> & { connector: TestGithubConnector }> {
  const gitSync = createTestGitSyncService({ state: { phase: 'disconnected' } })
  const connector = createTestGithubConnector()
  script?.(connector)
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ isMacosDesktop: false, hasMacosTitleBarOverlay: false }),
    // A stored PAT + GitHub accepting it ("alex") makes the auth step skip
    // itself, so a Continue lands straight on the finish step.
    secretStore: createTestSecretStoreService({
      'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }),
    }),
    http: createTestHttpService([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        reply: { status: 200, json: { login: 'alex' } },
      },
    ]),
    gitSync,
    githubConnector: connector,
  })
  const view = await renderInApp(ui, { app })
  return Object.assign(view, { connector })
}

describe('ConnectGithubDrawer', () => {
  it('suggests reflect-backup — never the local graph name — and connects', async () => {
    const onOpenChange = vi.fn()
    const { connector } = await mount(
      <ConnectGithubDrawer open onOpenChange={onOpenChange} pollIntervalMs={15} />,
      (scripted) => scripted.onConnectExistingRepo(() => Promise.resolve('notFound')),
    )

    // The local graph's display name is the sandbox folder ("Documents") —
    // the prefill must be the fixed fallback, not a graph-derived slug.
    await expect.element(page.getByLabelText('Repository name')).toHaveValue('reflect-backup')
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() => {
      expect(connector.calls()).toContainEqual({
        method: 'connectExistingRepo',
        ref: { owner: 'alex', name: 'reflect-backup' },
        allowPublic: false,
      })
    })
    await vi.waitFor(() => {
      expect(connector.calls()).toContainEqual({
        method: 'connectNewRepo',
        name: 'reflect-backup',
      })
    })
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('connects an existing repository and closes the sheet', async () => {
    const onOpenChange = vi.fn()
    const { connector } = await mount(
      <ConnectGithubDrawer open onOpenChange={onOpenChange} pollIntervalMs={15} />,
    )

    await page.getByRole('radio', { name: /use an existing repository/i }).click()
    fireEvent.change(page.getByPlaceholder('owner/name'), {
      target: { value: 'alex/notes' },
    })
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() => {
      expect(connector.calls()).toContainEqual({
        method: 'connectExistingRepo',
        ref: { owner: 'alex', name: 'notes' },
        allowPublic: false,
      })
    })
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('starts a fresh wizard on every open', async () => {
    const onOpenChange = vi.fn()
    const view = await mount(<ConnectGithubDrawer open onOpenChange={onOpenChange} />)

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
    await expect.element(page.getByRole('button', { name: 'Continue' })).not.toBeInTheDocument()

    // Reopen: back to the repo step defaults, no leaked error or mode.
    await view.rerender(<ConnectGithubDrawer open onOpenChange={onOpenChange} />)
    await expect
      .element(page.getByRole('radio', { name: /create a new private repository/i }))
      .toBeChecked()
    await expect.element(page.getByLabelText('Repository name')).toHaveValue('reflect-backup')
    await expect
      .element(page.getByText('Enter the repository as owner/name or a GitHub URL.'))
      .not.toBeInTheDocument()
  })
})
