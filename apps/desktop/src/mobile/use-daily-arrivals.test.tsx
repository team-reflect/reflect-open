import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDailyArrivals, type DailyArrivalsOptions } from './use-daily-arrivals'

/**
 * The daily surface's arrival bookkeeping (extracted from MobileDaily). The
 * contract: date-preserving re-arrivals re-anchor, capture arrivals focus,
 * swipe echoes do neither — and a focus arrival that raced the surface's
 * remount (the Daily-tab double-tap completing before the remounting screen
 * first commits, the from-another-tab bug) must still be honored.
 */

async function mountArrivals(initial: DailyArrivalsOptions) {
  return await renderHook((props: DailyArrivalsOptions = initial) => useDailyArrivals(props), {
    initialProps: initial,
  })
}

afterEach(() => {
  cleanup()
})

describe('useDailyArrivals', () => {
  it('a plain mount neither focuses nor re-anchors', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 3,
      arrivalFocusEditor: false,
      date: '2026-07-06',
    })
    expect(hook.result.current.focusDate).toBeNull()
    expect(hook.result.current.resetSeq).toBe(0)
  })

  it('honors a focus arrival that raced the mount', async () => {
    // Both double-tap navigations landed before the remounting surface first
    // committed: the mount already sees the final seq with the focus flag up.
    const hook = await mountArrivals({
      arrivalSeq: 3,
      arrivalFocusEditor: true,
      date: '2026-07-06',
    })
    expect(hook.result.current.focusDate).toBe('2026-07-06')
    expect(hook.result.current.resetSeq).toBe(0)
  })

  it('re-anchors on a date-preserving re-arrival', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
      date: '2026-07-06',
    })
    await hook.rerender({
      arrivalSeq: 2,
      arrivalFocusEditor: false,
      date: '2026-07-06',
    })
    expect(hook.result.current.resetSeq).toBe(1)
    expect(hook.result.current.focusDate).toBeNull()
  })

  it('focuses on a capture re-arrival (the double-tap while already shown)', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
      date: '2026-07-06',
    })
    await hook.rerender({
      arrivalSeq: 2,
      arrivalFocusEditor: true,
      date: '2026-07-06',
    })
    expect(hook.result.current.focusDate).toBe('2026-07-06')
    // The date-preserving arrival still bumps the reset — the slide skips the
    // jump-to-top itself while a focus request is pending.
    expect(hook.result.current.resetSeq).toBe(1)
  })

  it('ignores a swipe echo (the date moved with the seq)', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
      date: '2026-07-06',
    })
    await hook.rerender({
      arrivalSeq: 2,
      arrivalFocusEditor: false,
      date: '2026-07-07',
    })
    expect(hook.result.current.resetSeq).toBe(0)
    expect(hook.result.current.focusDate).toBeNull()
  })

  it('a later non-focus arrival clears a pending focus request', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 1,
      arrivalFocusEditor: true,
      date: '2026-07-06',
    })
    expect(hook.result.current.focusDate).toBe('2026-07-06')
    await hook.rerender({
      arrivalSeq: 2,
      arrivalFocusEditor: false,
      date: '2026-07-07',
    })
    expect(hook.result.current.focusDate).toBeNull()
  })

  it('consumeFocus clears the request without disturbing the reset seq', async () => {
    const hook = await mountArrivals({
      arrivalSeq: 1,
      arrivalFocusEditor: true,
      date: '2026-07-06',
    })
    act(() => {
      hook.result.current.consumeFocus()
    })
    expect(hook.result.current.focusDate).toBeNull()
    expect(hook.result.current.resetSeq).toBe(0)
  })
})
