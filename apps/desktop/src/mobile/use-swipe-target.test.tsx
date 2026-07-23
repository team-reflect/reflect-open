import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSwipeTarget } from './use-swipe-target'

/**
 * The strip's optimistic swipe target (extracted from MobileDaily). The
 * contract: a pointer-up target from the current arrival is followed, any new
 * router arrival clears it, and an update tagged with a superseded arrival —
 * a transition applying after a newer Today/strip/history navigation — must
 * not restore it.
 */

const ARRIVAL = '0:1:2026-07-06'
const NEXT_ARRIVAL = '0:2:2026-07-06'

async function mountSwipeTarget(navigationKey: string) {
  return await renderHook(
    (props: { navigationKey: string } = { navigationKey }) =>
      useSwipeTarget(props.navigationKey),
    {
      initialProps: { navigationKey },
    },
  )
}

afterEach(() => {
  cleanup()
})

describe('useSwipeTarget', () => {
  it('starts with no target', async () => {
    const hook = await mountSwipeTarget(ARRIVAL)
    expect(hook.result.current.targetDate).toBeNull()
  })

  it('follows a target announced by the current arrival', async () => {
    const hook = await mountSwipeTarget(ARRIVAL)
    act(() => hook.result.current.followSwipeTarget('2026-07-07', ARRIVAL))
    expect(hook.result.current.targetDate).toBe('2026-07-07')
  })

  it('clears the target on any new arrival', async () => {
    const hook = await mountSwipeTarget(ARRIVAL)
    act(() => hook.result.current.followSwipeTarget('2026-07-07', ARRIVAL))

    // A date-preserving Today tap: only the arrival identity moves.
    await hook.rerender({ navigationKey: NEXT_ARRIVAL })

    expect(hook.result.current.targetDate).toBeNull()
  })

  it('rejects a target from a superseded arrival', async () => {
    const hook = await mountSwipeTarget(ARRIVAL)
    await hook.rerender({ navigationKey: NEXT_ARRIVAL })

    // The old swipe's deferred pointer-up work lands after Today has won.
    act(() => hook.result.current.followSwipeTarget('2026-07-07', ARRIVAL))

    expect(hook.result.current.targetDate).toBeNull()
  })

  it('keeps following the arrival that owns the gesture', async () => {
    const hook = await mountSwipeTarget(ARRIVAL)
    act(() => hook.result.current.followSwipeTarget('2026-07-07', ARRIVAL))
    await hook.rerender({ navigationKey: NEXT_ARRIVAL })

    // A fresh swipe under the new arrival is followed again.
    act(() => hook.result.current.followSwipeTarget('2026-07-05', NEXT_ARRIVAL))

    expect(hook.result.current.targetDate).toBe('2026-07-05')
  })
})
