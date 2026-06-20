/**
 * Flow 5b — context sidebar: DayCalendar noted-dates Set allocation.
 *
 * `const noted = new Set(notedDates ?? [])` allocated a fresh Set on every
 * render; the right sidebar re-renders as the focused day scrolls through the
 * stream. `useMemo` rebuilds the Set only when the query result changes. The
 * Set has no memoized consumer, so the effect is avoided allocation, not a
 * render-count delta — this bench measures it directly by counting how many
 * times the component constructs a Set from the (reference-stable) notedDates
 * array across a burst of parent re-renders.
 */

import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildDataset } from './lib/dataset'
import { record } from './lib/record'

const dataset = buildDataset()
const RERENDERS = 24
// A stable reference is what structural sharing gives the query result in
// production; the component keys its useMemo on it.
const notedDates = [...dataset.notedDatesInMonth]

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { weekStartDay: 'monday', dateFormat: 'mdy' }, updateSettings: () => {} }),
}))
vi.mock('@/routing/router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: notedDates }),
}))

const { DayCalendar } = await import('@/components/context-sidebar/day-calendar')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function Sidebar(): ReactElement {
  const [tick, setTick] = useState(0)
  return (
    <TooltipProvider>
      <button type="button" data-tick={tick} onClick={() => setTick((value) => value + 1)}>
        scroll-focus
      </button>
      <DayCalendar selectedDate="2026-06-15" today="2026-06-20" />
    </TooltipProvider>
  )
}

describe('DayCalendar churn (noted-dates Set)', () => {
  it('measures noted-dates Set allocations across re-renders', async () => {
    const RealSet = globalThis.Set
    let setBuilds = 0
    class CountingSet<T> extends RealSet<T> {
      constructor(iterable?: Iterable<T> | null) {
        super(iterable as Iterable<T>)
        // Only count the component's own `new Set(notedDates)`, identified by
        // the exact array reference — never React's internal Sets.
        if (iterable === (notedDates as unknown as Iterable<T>)) {
          setBuilds += 1
        }
      }
    }
    globalThis.Set = CountingSet as unknown as SetConstructor

    let mountBuilds = 0
    let totalBuilds = 0
    try {
      const view = render(<Sidebar />)
      mountBuilds = setBuilds

      const button = view.getByRole('button', { name: 'scroll-focus' })
      for (let index = 0; index < RERENDERS; index += 1) {
        await userEvent.click(button)
      }
      totalBuilds = setBuilds
      view.unmount()
    } finally {
      globalThis.Set = RealSet
    }

    record({
      flow: 'flow-5b-day-calendar-set',
      description:
        `noted-dates Set constructions across ${RERENDERS} sidebar re-renders ` +
        `(stable query result of ${notedDates.length} dates).`,
      metrics: {
        notedDates: notedDates.length,
        rerenders: RERENDERS,
        mountSetBuilds: mountBuilds,
        rerenderSetBuilds: totalBuilds - mountBuilds,
        totalSetBuilds: totalBuilds,
      },
    })
    expect(totalBuilds).toBeGreaterThanOrEqual(mountBuilds)
  })
})
