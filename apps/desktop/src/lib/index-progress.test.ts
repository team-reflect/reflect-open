import { afterEach, describe, expect, it, vi } from 'vitest'
import { getIndexProgress, setIndexProgress, subscribeIndexProgress } from './index-progress'

afterEach(() => {
  setIndexProgress(null)
})

describe('index progress store', () => {
  it('publishes progress to subscribers and exposes the snapshot', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeIndexProgress(listener)

    setIndexProgress({ done: 16, total: 3000, worked: 16 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getIndexProgress()).toEqual({ done: 16, total: 3000, worked: 16 })

    setIndexProgress(null)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getIndexProgress()).toBeNull()
    unsubscribe()
  })

  it('drops value-equal updates — per-tick reporters must not re-render the pill', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeIndexProgress(listener)

    setIndexProgress({ done: 16, total: 3000, worked: 0 })
    setIndexProgress({ done: 16, total: 3000, worked: 0 }) // same values, new object
    expect(listener).toHaveBeenCalledTimes(1)

    setIndexProgress(null)
    setIndexProgress(null) // already clear
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    subscribeIndexProgress(listener)()

    setIndexProgress({ done: 1, total: 200, worked: 1 })
    expect(listener).not.toHaveBeenCalled()
  })
})
