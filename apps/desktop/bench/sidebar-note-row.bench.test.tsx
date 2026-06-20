/**
 * Flow 5a — sidebar pinned shelf: SidebarNoteRow render churn.
 *
 * The sidebar reads `useRouter` and re-renders on every route change. Each
 * pinned row recomputes `routeForPath`/`routesEqual`. `React.memo(SidebarNoteRow)`
 * lets rows with unchanged props bail. This bench renders the dataset's deep
 * pinned shelf and forces route-change-style parent re-renders, counting row
 * body executions via a spy on `routeForPath` (called once per row render).
 */

import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildDataset } from './lib/dataset'
import { record } from './lib/record'

const dataset = buildDataset()
const PINNED_ROWS = dataset.pinned.length
const ROUTE_CHANGES = 12

const routeForPath = vi.hoisted(() => vi.fn((path: string) => ({ kind: 'note', path })))
vi.mock('@/routing/route', () => ({ routeForPath, routesEqual: () => false }))
vi.mock('@/routing/router', () => ({
  useRouter: () => ({ route: { kind: 'today' }, navigate: vi.fn() }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'iso' }, updateSettings: () => {} }),
}))

const { SidebarNoteRow } = await import('@/components/sidebar/sidebar-note-row')

function PinnedShelf(): ReactElement {
  const [tick, setTick] = useState(0)
  return (
    <div>
      <button type="button" data-tick={tick} onClick={() => setTick((value) => value + 1)}>
        route-change
      </button>
      <ul>
        {dataset.pinned.map((entry) => (
          <SidebarNoteRow key={entry.path} path={entry.path} title={entry.title} date={entry.date} />
        ))}
      </ul>
    </div>
  )
}

describe('SidebarNoteRow churn (pinned shelf)', () => {
  it('measures row body executions across route-change re-renders', async () => {
    routeForPath.mockClear()
    const view = render(<PinnedShelf />)
    const mountRenders = routeForPath.mock.calls.length

    const button = view.getByRole('button', { name: 'route-change' })
    for (let index = 0; index < ROUTE_CHANGES; index += 1) {
      await userEvent.click(button)
    }
    const totalRenders = routeForPath.mock.calls.length

    record({
      flow: 'flow-5a-sidebar-pinned',
      description:
        `SidebarNoteRow body executions across ${ROUTE_CHANGES} route-change re-renders ` +
        `of a ${PINNED_ROWS}-row pinned shelf with unchanged row props.`,
      metrics: {
        pinnedRows: PINNED_ROWS,
        routeChanges: ROUTE_CHANGES,
        mountRowRenders: mountRenders,
        rerenderRowRenders: totalRenders - mountRenders,
        totalRowRenders: totalRenders,
      },
    })
    view.unmount()
    expect(totalRenders).toBeGreaterThanOrEqual(mountRenders)
  })
})
