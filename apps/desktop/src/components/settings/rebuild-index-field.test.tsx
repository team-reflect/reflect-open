import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rebuildIndexVisibly = vi.hoisted(() => vi.fn(async () => undefined))
const graph = vi.hoisted(() => ({ indexGeneration: 7 as number | null }))
vi.mock('@/lib/rebuild-index', () => ({ rebuildIndexVisibly }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ indexGeneration: graph.indexGeneration }),
}))

const { RebuildIndexField } = await import('./rebuild-index-field')

function rebuildButton(): HTMLButtonElement {
  const element = screen.getByRole('button', { name: /rebuild/i })
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('expected a <button>')
  }
  return element
}

beforeEach(() => {
  graph.indexGeneration = 7
  rebuildIndexVisibly.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('RebuildIndexField', () => {
  it('rebuilds at the open index generation', async () => {
    render(<RebuildIndexField />)

    fireEvent.click(rebuildButton())

    await waitFor(() => expect(rebuildIndexVisibly).toHaveBeenCalledWith(7))
  })

  it('disables the button while a rebuild is in flight, then re-enables it', async () => {
    let finish: () => void = () => {}
    rebuildIndexVisibly.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(undefined))),
    )
    render(<RebuildIndexField />)

    fireEvent.click(rebuildButton())

    const pending = await screen.findByRole('button', { name: /rebuilding/i })
    expect(pending.hasAttribute('disabled')).toBe(true)

    finish()
    await waitFor(() => expect(rebuildButton().hasAttribute('disabled')).toBe(false))
  })

  it('is disabled when no graph index is open', () => {
    graph.indexGeneration = null
    render(<RebuildIndexField />)

    expect(rebuildButton().hasAttribute('disabled')).toBe(true)
    fireEvent.click(rebuildButton())
    expect(rebuildIndexVisibly).not.toHaveBeenCalled()
  })
})
