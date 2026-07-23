import { render } from 'vitest-browser-react'
import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rebuildIndexVisibly = vi.hoisted(() => vi.fn(async () => undefined))
const graph = vi.hoisted(() => ({ indexGeneration: 7 as number | null }))
vi.mock('@/lib/rebuild-index', () => ({ rebuildIndexVisibly }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ indexGeneration: graph.indexGeneration }),
}))

const { RebuildIndexField } = await import('./rebuild-index-field')

function rebuildButton(): Locator {
  return page.getByRole('button', { name: /rebuild/i })
}

beforeEach(() => {
  graph.indexGeneration = 7
  rebuildIndexVisibly.mockClear()
})

describe('RebuildIndexField', () => {
  it('rebuilds at the open index generation', async () => {
    await render(<RebuildIndexField />)

    await rebuildButton().click()

    await vi.waitFor(() => expect(rebuildIndexVisibly).toHaveBeenCalledWith(7))
  })

  it('disables the button while a rebuild is in flight, then re-enables it', async () => {
    let finish: () => void = () => {}
    rebuildIndexVisibly.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(undefined))),
    )
    await render(<RebuildIndexField />)

    await rebuildButton().click()

    await expect.element(page.getByRole('button', { name: /rebuilding/i })).toBeDisabled()

    finish()
    await expect.element(rebuildButton()).toBeEnabled()
  })

  it('is disabled when no graph index is open', async () => {
    graph.indexGeneration = null
    await render(<RebuildIndexField />)

    await expect.element(rebuildButton()).toBeDisabled()
    await rebuildButton().click({ force: true })
    expect(rebuildIndexVisibly).not.toHaveBeenCalled()
  })
})
