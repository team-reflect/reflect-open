import { useState, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { NoteTagFacet } from '@reflect/core'
import { FilterBar } from './filter-bar'
import { EMPTY_ALL_NOTES_FILTERS, type AllNotesFilters } from './filter-state'

/**
 * The filter badge row (Plan 19): chips toggle or open pickers, everything
 * ANDs, and Reset clears the lot including the route tag. The drawer wrapper
 * is vaul, which needs browser APIs jsdom doesn't provide; as in
 * `note-actions-menu.test.tsx` it's mocked to a passthrough so picker rows
 * are always rendered and the state flow is what's exercised.
 */

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <>{children}</> : null,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
setBridge({ invoke: mockInvoke, listen: async () => () => {} })

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue([])
})

afterEach(cleanup)

const FACETS: NoteTagFacet[] = [
  { tag: 'Book', count: 3 },
  { tag: 'work', count: 5 },
]

/** The bar under a stateful owner, the way the shell owns filters. */
function Harness({
  routeTag = null,
  onClearRouteTag = () => {},
  onChange = () => {},
}: {
  routeTag?: string | null
  onClearRouteTag?: () => void
  onChange?: (filters: AllNotesFilters) => void
}): ReactElement {
  const [filters, setFilters] = useState(EMPTY_ALL_NOTES_FILTERS)
  return (
    <FilterBar
      filters={filters}
      onFiltersChange={(next) => {
        setFilters(next)
        onChange(next)
      }}
      facets={FACETS}
      routeTag={routeTag}
      onClearRouteTag={onClearRouteTag}
    />
  )
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return await render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  )
}

describe('FilterBar', () => {
  it('toggles the Pinned chip and shows Reset only while something is active', async () => {
    const changes: AllNotesFilters[] = []
    const view = await mount({ onChange: (next) => changes.push(next) })

    expect(view.getByRole('button', { name: /Reset/ }).query()).toBeNull()

    await userEvent.click(view.getByRole('button', { name: 'Pinned' }))
    expect(changes.at(-1)?.pinned).toBe(true)
    await expect
      .element(view.getByRole('button', { name: 'Pinned' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect.element(view.getByRole('button', { name: /Reset/ })).toBeVisible()

    await userEvent.click(view.getByRole('button', { name: 'Pinned' }))
    expect(changes.at(-1)?.pinned).toBe(false)
    await expect.element(view.getByRole('button', { name: /Reset/ })).not.toBeInTheDocument()
  })

  it('multi-selects tags through the drawer and labels the chip with the first tag', async () => {
    const changes: AllNotesFilters[] = []
    const view = await mount({ onChange: (next) => changes.push(next) })

    await userEvent.click(view.getByRole('button', { name: 'Tags' }))
    await userEvent.click(view.getByRole('button', { name: /#Book/ }))
    await userEvent.click(view.getByRole('button', { name: /#work/ }))

    expect(changes.at(-1)?.tags).toEqual(['book', 'work'])
    await expect.element(view.getByRole('button', { name: '#Book +1' })).toBeVisible()
  })

  it('resets badges and the route tag together', async () => {
    const onClearRouteTag = vi.fn()
    const changes: AllNotesFilters[] = []
    const view = await mount({
      routeTag: 'Book',
      onClearRouteTag,
      onChange: (next) => changes.push(next),
    })

    // The route tag alone makes the bar active.
    await userEvent.click(view.getByRole('button', { name: 'Daily notes' }))
    await userEvent.click(view.getByRole('button', { name: /Reset/ }))

    expect(changes.at(-1)).toEqual(EMPTY_ALL_NOTES_FILTERS)
    expect(onClearRouteTag).toHaveBeenCalledTimes(1)
  })

  it('activates an updated preset and clears it from the drawer', async () => {
    const changes: AllNotesFilters[] = []
    const view = await mount({ onChange: (next) => changes.push(next) })

    await userEvent.click(view.getByRole('button', { name: 'Updated' }))
    await userEvent.click(view.getByRole('button', { name: 'Last 7 days' }))
    expect(changes.at(-1)?.updated?.label).toBe('Last 7 days')
    await expect.element(view.getByRole('button', { name: 'Last 7 days' })).toBeVisible()

    await userEvent.click(view.getByRole('button', { name: 'Last 7 days' }))
    await userEvent.click(view.getByRole('button', { name: 'Clear filter' }))
    expect(changes.at(-1)?.updated).toBeNull()
  })
})
