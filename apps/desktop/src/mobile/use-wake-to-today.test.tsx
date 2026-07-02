import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useWakeToToday } from './use-wake-to-today'

/**
 * V1's wake-to-today: foregrounding the app on a later calendar date than it
 * was backgrounded on navigates to today; a same-day foreground stays put.
 * Visibility is simulated by overriding `document.visibilityState` and
 * dispatching `visibilitychange`; the clock via fake timers.
 */

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function Probe(): ReactElement {
  useWakeToToday()
  const { route } = useRouter()
  return <output>{route.kind === 'daily' ? `daily:${route.date}` : route.kind}</output>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 5, 12, 22, 0, 0)) // 2026-06-12, late evening
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  visibility = 'visible'
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mountOn(date: string): ReturnType<typeof render> {
  return render(
    <RouterProvider initialRoute={{ kind: 'daily', date }}>
      <Probe />
    </RouterProvider>,
  )
}

describe('useWakeToToday', () => {
  it('navigates to today when the app foregrounds on a new date', () => {
    const view = mountOn('2026-06-10')
    expect(view.getByRole('status').textContent).toBe('daily:2026-06-10')

    setVisibility('hidden')
    vi.setSystemTime(new Date(2026, 5, 13, 8, 0, 0)) // overnight in the background
    setVisibility('visible')

    expect(view.getByRole('status').textContent).toBe('today')
  })

  it('stays put when the app foregrounds on the same date', () => {
    const view = mountOn('2026-06-10')

    setVisibility('hidden')
    vi.setSystemTime(new Date(2026, 5, 12, 23, 30, 0)) // later the same evening
    setVisibility('visible')

    expect(view.getByRole('status').textContent).toBe('daily:2026-06-10')
  })
})
