import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { useSync, useSyncContext } from './sync-provider.tsx'

function Probe(): ReactElement {
  const sync = useSync()
  const context = useSyncContext()
  async function backUpNow(): Promise<void> {
    try {
      await sync.backUpNow()
    } catch {
      // The probe only records the call.
    }
  }
  return (
    <button
      type="button"
      data-context={context === null ? 'none' : 'some'}
      onClick={() => void backUpNow()}
    >
      {sync.backup.phase}
    </button>
  )
}

describe('useSync', () => {
  it('publishes the graph backup state and passes actions through', async () => {
    const { backup } = await renderInApp(<Probe />, { sync: { phase: 'loading' } })

    backup?.setState({ phase: 'disconnected' })
    await page.getByRole('button', { name: 'disconnected' }).click()

    expect(backup?.calls()).toEqual([{ method: 'start' }, { method: 'backUpNow' }])
  })

  it('reads loading, and no context, where the graph runs no backup', async () => {
    const app = createTestCoreServices({ role: 'note-window' })
    await renderInApp(<Probe />, { app })

    const button = page.getByRole('button', { name: 'loading' })
    await expect.element(button).toHaveAttribute('data-context', 'none')
  })
})
