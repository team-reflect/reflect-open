import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedStatus } from '@reflect/core'
import { resetOperations } from '@/lib/operations'

const rebuildIndex = vi.hoisted(() =>
  vi.fn<(options: { generation: number }) => Promise<void>>(async () => undefined),
)
const embedStatus = vi.hoisted(() =>
  vi.fn<() => Promise<EmbedStatus>>(async () => ({ status: 'uninitialized' })),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  rebuildIndex,
  embedStatus,
}))

const { rebuildIndexVisibly } = await import('./rebuild-index')

beforeEach(() => {
  rebuildIndex.mockClear()
})

afterEach(() => {
  resetOperations()
})

describe('rebuildIndexVisibly', () => {
  it('coalesces concurrent requests at the same generation onto one pass', async () => {
    let finish: () => void = () => {}
    rebuildIndex.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(undefined))),
    )

    const first = rebuildIndexVisibly(7)
    const second = rebuildIndexVisibly(7)

    expect(second).toBe(first)
    expect(rebuildIndex).toHaveBeenCalledTimes(1)

    finish()
    await first

    // Once settled, the guard is released and the next request rebuilds again.
    await rebuildIndexVisibly(7)
    expect(rebuildIndex).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh pass for a different generation', async () => {
    let finishFirst: () => void = () => {}
    rebuildIndex.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = () => resolve(undefined))),
    )

    const first = rebuildIndexVisibly(7)
    await rebuildIndexVisibly(8)

    expect(rebuildIndex).toHaveBeenCalledTimes(2)
    expect(rebuildIndex).toHaveBeenNthCalledWith(2, { generation: 8 })

    finishFirst()
    await first
  })

  it('absorbs a failed rebuild and releases the in-flight guard', async () => {
    rebuildIndex.mockRejectedValueOnce(new Error('index on fire'))
    await expect(rebuildIndexVisibly(7)).resolves.toBeUndefined()

    await rebuildIndexVisibly(7)
    expect(rebuildIndex).toHaveBeenCalledTimes(2)
  })
})
