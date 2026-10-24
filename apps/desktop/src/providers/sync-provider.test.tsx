import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useGitSync, useGitSyncContext } from './sync-provider.tsx'

function Probe(): ReactElement {
  const sync = useGitSync()
  const context = useGitSyncContext()
  async function syncNow(): Promise<void> {
    try {
      await sync.syncNow()
    } catch {
      // The probe only records the call.
    }
  }
  return (
    <button
      type="button"
      data-context={context === null ? 'none' : 'some'}
      onClick={() => void syncNow()}
    >
      {sync.state.phase}
    </button>
  )
}

describe('useGitSync', () => {
  it('publishes the graph backup state and passes actions through', async () => {
    const { gitSync } = await renderInApp(<Probe />, { sync: { phase: 'loading' } })

    gitSync?.setState({ phase: 'disconnected' })
    await page.getByRole('button', { name: 'disconnected' }).click()

    expect(gitSync?.calls()).toEqual([{ method: 'start' }, { method: 'syncNow' }])
  })

  it('reads loading, and no context, where the graph runs no backup', async () => {
    const core = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      role: 'note-window',
    })
    await renderInApp(<Probe />, { core })

    const button = page.getByRole('button', { name: 'loading' })
    await expect.element(button).toHaveAttribute('data-context', 'none')
  })
})
