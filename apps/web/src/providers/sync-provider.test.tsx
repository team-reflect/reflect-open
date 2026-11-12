import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useGitSyncActions, useGitSyncState } from './sync-provider.tsx'

function Probe(): ReactElement {
  const state = useGitSyncState()
  const actions = useGitSyncActions()
  async function syncNow(): Promise<void> {
    try {
      await actions.syncNow()
    } catch {
      // The probe only records the call.
    }
  }
  return (
    <button type="button" onClick={() => void syncNow()}>
      {state.phase}
    </button>
  )
}

describe('useGitSyncState', () => {
  it('publishes the graph backup state and passes actions through', async () => {
    const { gitSync } = await renderInApp(<Probe />, { sync: { phase: 'loading' } })

    gitSync?.setState({ phase: 'disconnected' })
    await page.getByRole('button', { name: 'disconnected' }).click()

    expect(gitSync?.calls()).toEqual([{ method: 'start' }, { method: 'syncNow' }])
  })

  it('reads loading where the graph runs no backup', async () => {
    const core = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      role: 'note-window',
    })
    await renderInApp(<Probe />, { core })

    await expect.element(page.getByRole('button', { name: 'loading' })).toBeInTheDocument()
  })
})
