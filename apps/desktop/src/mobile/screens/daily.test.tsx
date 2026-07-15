import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const graphState = vi.hoisted((): { graph: import('@reflect/core').GraphInfo | null } => ({
  graph: null,
}))

vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))
vi.mock('@/routing/router', () => ({
  useRouter: () => ({
    navigate: vi.fn(),
    entryId: 'entry',
    arrivalSeq: 1,
    arrivalFocusEditor: false,
  }),
}))
vi.mock('@/lib/use-today', () => ({ useToday: () => '2026-07-15' }))
vi.mock('@/mobile/use-swipe-target', () => ({
  useSwipeTarget: () => ({ targetDate: null, followSwipeTarget: vi.fn() }),
}))
vi.mock('@/mobile/use-daily-arrivals', () => ({
  useDailyArrivals: () => ({ resetSeq: 0, focusDate: null, consumeFocus: vi.fn() }),
}))
vi.mock('@/mobile/calendar-strip', () => ({ CalendarStrip: () => null }))
vi.mock('@/mobile/day-carousel', () => ({ DayCarousel: () => null }))
vi.mock('@/mobile/audio-memo-fab', () => ({ AudioMemoFab: () => null }))

const { MobileDaily } = await import('./daily')

afterEach(() => {
  cleanup()
  graphState.graph = null
})

describe('MobileDaily', () => {
  it('disables new-note creation while no graph is available', () => {
    const view = render(<MobileDaily date="2026-07-15" />)
    expect(view.getByRole('button', { name: 'New note' }).hasAttribute('disabled')).toBe(true)
  })
})
