import { page, type Locator } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RebuildIndexField } from './rebuild-index-field.tsx'

function rebuildButton(): Locator {
  return page.getByRole('button', { name: /rebuild/i })
}

describe('RebuildIndexField', () => {
  it('rebuilds at the open index generation', async () => {
    const { app } = await renderInApp(<RebuildIndexField />, { graph: { indexGeneration: 7 } })

    await rebuildButton().click()

    await vi.waitFor(() => expect(app.indexLifecycle.rebuilds()).toEqual([7]))
  })

  it('disables the button while a rebuild is in flight, then re-enables it', async () => {
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const rebuild = Promise.withResolvers<void>()
    vi.spyOn(app.indexLifecycle, 'rebuildVisibly').mockReturnValueOnce(rebuild.promise)
    await renderInApp(<RebuildIndexField />, { app, graph: { indexGeneration: 7 } })

    await rebuildButton().click()

    await expect.element(page.getByRole('button', { name: /rebuilding/i })).toBeDisabled()

    rebuild.resolve()
    await expect.element(rebuildButton()).toBeEnabled()
  })

  it('is disabled when no graph index is open', async () => {
    const { app } = await renderInApp(<RebuildIndexField />, { graph: { indexGeneration: null } })

    await expect.element(rebuildButton()).toBeDisabled()
    await rebuildButton().click({ force: true })
    expect(app.indexLifecycle.rebuilds()).toEqual([])
  })
})
