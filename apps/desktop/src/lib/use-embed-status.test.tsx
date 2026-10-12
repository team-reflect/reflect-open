import { afterEach, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { setBridge } from '@reflect/core'
import { useEmbedStatus } from './use-embed-status.ts'

afterEach(() => {
  setBridge(null)
})

it('starts a later mount from the last status an earlier mount received', async () => {
  setBridge({
    invoke: async () => ({ status: 'unsupported' }),
    listen: async () => () => {},
  })
  const first = await renderHook(() => useEmbedStatus())
  await vi.waitFor(() => expect(first.result.current).toEqual({ status: 'unsupported' }))
  await first.unmount()

  const seen: string[] = []
  await renderHook(() => {
    const status = useEmbedStatus()
    seen.push(status.status)
    return status
  })

  expect(seen[0]).toBe('unsupported')
})
