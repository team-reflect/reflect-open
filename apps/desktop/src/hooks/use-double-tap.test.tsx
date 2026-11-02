import { act } from '@/test-utils/act.ts'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDoubleTap } from './use-double-tap.ts'

async function mountTaps(activeKey: string | null = 'a') {
  return await renderHook((active: string | null = activeKey) => useDoubleTap<string>(active), {
    initialProps: activeKey,
  })
}

afterEach(async () => {
  await cleanup()
})

/** Pin Date.now so tap spacing is exact (the gesture-test convention). */
function atTimes(...times: number[]): void {
  const clock = vi.spyOn(Date, 'now')
  for (const time of times) {
    clock.mockImplementationOnce(() => time)
  }
}

describe('useDoubleTap', () => {
  it('pairs two taps of the same key within the window', async () => {
    const hook = await mountTaps()
    atTimes(1000, 1400)
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
    await act(() => {
      expect(hook.result.current('a')).toBe(true)
    })
  })

  it('does not pair taps spaced past the window', async () => {
    const hook = await mountTaps()
    atTimes(1000, 1500)
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
  })

  it('a tap of another key starts a fresh pairing', async () => {
    const hook = await mountTaps()
    atTimes(1000, 1100, 1200)
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
    await act(() => {
      expect(hook.result.current('b')).toBe(false)
    })
    await act(() => {
      expect(hook.result.current('b')).toBe(true)
    })
  })

  it('survives the active-key change the first tap itself causes', async () => {
    // The mobile tab bar's case: tapping All from Daily moves the route onto
    // the All root before the second tap — the pending tap must still pair.
    const hook = await mountTaps('a')
    atTimes(1000, 1100)
    await act(() => {
      expect(hook.result.current('b')).toBe(false)
    })
    await hook.rerender('b')
    await act(() => {
      expect(hook.result.current('b')).toBe(true)
    })
  })

  it('expires a pending tap when the active key leaves it', async () => {
    // Something else moved the state off the key between the taps (a deep
    // link, an opened note): the second tap is a return, not a double-tap.
    const hook = await mountTaps('a')
    atTimes(1000, 1100)
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
    await hook.rerender(null)
    await hook.rerender('a')
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
  })

  it('honors a custom window', async () => {
    const hook = await renderHook(() => useDoubleTap<string>('a', 100))
    atTimes(1000, 1150)
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
    await act(() => {
      expect(hook.result.current('a')).toBe(false)
    })
  })
})
