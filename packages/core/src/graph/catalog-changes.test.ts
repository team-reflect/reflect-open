import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  FILE_CATALOG_CHANGED_EVENT,
  subscribeFileCatalogChanged,
  type FileCatalogChanged,
} from './catalog-changes'

afterEach(() => {
  setBridge(null)
  vi.restoreAllMocks()
})

describe('subscribeFileCatalogChanged', () => {
  it('validates generation-pinned native events and cleans up', async () => {
    let emit = (_payload: unknown): void => {
      throw new Error('catalog listener was not registered')
    }
    const unlisten = vi.fn()
    setBridge({
      invoke: async () => null,
      listen: async (event, handler) => {
        expect(event).toBe(FILE_CATALOG_CHANGED_EVENT)
        emit = handler
        return unlisten
      },
    })
    const seen: FileCatalogChanged[] = []
    const unsubscribe = await subscribeFileCatalogChanged((change) => seen.push(change))

    emit({ generation: 7 })
    expect(seen).toEqual([{ generation: 7 }])
    unsubscribe()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('drops malformed events', async () => {
    let emit = (_payload: unknown): void => {
      throw new Error('catalog listener was not registered')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setBridge({
      invoke: async () => null,
      listen: async (_event, handler) => {
        emit = handler
        return () => {}
      },
    })
    const handler = vi.fn()
    await subscribeFileCatalogChanged(handler)

    emit({ generation: -1 })
    emit({ generation: 7, root: '/wrong' })
    expect(handler).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(2)
  })
})
