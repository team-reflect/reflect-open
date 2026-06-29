import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { format } from 'date-fns'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router'
import type { Route } from '@/routing/route'
import { addDaysIso, formatDayLabel, parseIsoDate, todayIso } from '@/lib/dates'
import { monthLabel, weekOf } from './calendar'
import { MobileShell } from './mobile-shell'

// jsdom implements none of these; Embla (the day carousel) needs them to init.
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}
globalThis.ResizeObserver ??= ObserverStub as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= ObserverStub as unknown as typeof IntersectionObserver
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia

/**
 * The tabbed mobile shell (Plan 19, V1 parity): the daily spine pages
 * between days, the All tab lists and searches, a note screen pops back to
 * where it came from, and a cold note entry lands on today. Drives the real
 * router → MobileShell → screens → NotePane stack over a fake IPC bridge;
 * only the ProseMirror view is stubbed (jsdom can't host contenteditable),
 * mirroring `route-content.test.tsx`.
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: ({ initialContent }: { initialContent: string }) => (
    <div data-testid="fake-editor">{initialContent}</div>
  ),
}))

const indexFns = vi.hoisted(() => ({
  getBacklinksWithContext: vi.fn(async () => []),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: indexFns.getBacklinksWithContext,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { editorMarkdownSyntax: 'hide', dateFormat: 'mdy', weekStartDay: 'monday' },
    updateSettings: async () => {},
  }),
}))

/** The fake graph: files behind the IPC bridge. */
let files: Record<string, string>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({
  invoke: mockInvoke,
  listen: async () => () => {},
})

beforeEach(() => {
  files = {}
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' } // AppError shape
      }
      return content
    }
    if (command === 'note_write') {
      const { path, contents } = args as { path: string; contents: string }
      files[path] = contents
      return null
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
})

function mount(initialRoute: Route, probeRoute?: Route) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider initialRoute={initialRoute}>
        <MobileShell />
        {probeRoute ? <NavProbe to={probeRoute} /> : null}
      </RouterProvider>
    </QueryClientProvider>,
  )
}

/** Stands in for a wiki-link tap: navigation arriving from inside a screen. */
function NavProbe({ to }: { to: Route }): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate(to)}>
      probe-navigate
    </button>
  )
}

/** The calendar strip's per-day aria-label (CalendarStrip uses this form). */
function dayCellLabel(date: string): string {
  return format(parseIsoDate(date), 'EEEE, MMMM do')
}

/** A day in `date`'s week that isn't `date` itself (always present). */
function otherDayInWeek(date: string): string {
  const week = weekOf(date, 'monday')
  return week.find((day) => day !== date) ?? week[0]!
}

describe('MobileShell', () => {
  it('renders today as the daily spine with its note content', async () => {
    const today = todayIso()
    files[`daily/${today}.md`] = 'captured on the go'
    const view = await mount({ kind: 'today' })

    // The header is the month; the carousel mounts today's slide (±1
    // neighbours), each carrying its formatted date as the note's subject.
    await expect.element(view.getByRole('heading', { level: 1 })).toHaveTextContent(monthLabel(today))
    await expect.element(view.getByText(formatDayLabel(today, 'mdy'))).toBeInTheDocument()
    await vi.waitFor(() => {
      const editors = view.getByTestId('fake-editor').all()
      expect(
        editors.some((editor) => editor.element().textContent?.includes('captured on the go')),
      ).toBe(true)
    })
  })

  it('selects a day from the calendar strip and jumps back to today', async () => {
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await expect.element(view.getByRole('button', { name: 'Today' })).not.toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: dayCellLabel(other) }))
    await expect
      .element(view.getByRole('button', { name: dayCellLabel(other) }))
      .toHaveAttribute('aria-current', 'date')
    await expect.element(view.getByRole('button', { name: 'Today' })).toBeInTheDocument()

    await userEvent.click(view.getByRole('button', { name: 'Today' }))
    await expect.element(view.getByRole('button', { name: 'Today' })).not.toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: dayCellLabel(today) }))
      .toHaveAttribute('aria-current', 'date')
  })

  it('re-anchors the carousel when a date link lands outside its window', async () => {
    // Beyond the ±366-day window, only reachable as a date-link navigation,
    // which forces the carousel to rebuild its window around the day.
    const farDay = addDaysIso(todayIso(), 400)
    files[`daily/${farDay}.md`] = 'far future plans'
    const view = await mount({ kind: 'today' }, { kind: 'daily', date: farDay })

    await userEvent.click(view.getByRole('button', { name: 'probe-navigate' }))
    await expect.element(view.getByRole('heading', { level: 1 })).toHaveTextContent(monthLabel(farDay))
    await vi.waitFor(() => {
      const editors = view.getByTestId('fake-editor').all()
      expect(
        editors.some((editor) => editor.element().textContent?.includes('far future plans')),
      ).toBe(true)
    })
  })

  it('opens a note from in-screen navigation and pops back through history', async () => {
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await userEvent.click(view.getByRole('button', { name: 'probe-navigate' }))
    await expect.element(view.getByRole('heading')).toHaveTextContent('meeting-notes')

    await userEvent.click(view.getByRole('button', { name: 'Back' }))
    await expect
      .element(view.getByRole('heading', { level: 1 }))
      .toHaveTextContent(monthLabel(todayIso()))
  })

  it('switches tabs: All shows the searchable list, Daily returns to today', async () => {
    const view = await mount({ kind: 'today' })

    await userEvent.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeInTheDocument()
    await expect.element(view.getByText('No notes yet')).toHaveTextContent('No notes yet')

    await userEvent.click(view.getByRole('button', { name: 'Daily' }))
    await expect
      .element(view.getByRole('heading', { level: 1 }))
      .toHaveTextContent(monthLabel(todayIso()))
  })

  it('renders a search entry as the All tab with the query seeded', async () => {
    const view = await mount({ kind: 'search', query: 'meeting' })

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await expect.element(box).toHaveValue('meeting')
    await expect
      .element(view.getByRole('button', { name: 'All' }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('back from a cold note entry lands on today', async () => {
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'note', path: 'notes/meeting-notes.md' })

    await expect.element(view.getByRole('heading')).toHaveTextContent('meeting-notes')
    await expect.element(view.getByTestId('fake-editor')).toHaveTextContent('agenda')

    await userEvent.click(view.getByRole('button', { name: 'Back' }))
    await expect
      .element(view.getByRole('heading', { level: 1 }))
      .toHaveTextContent(monthLabel(todayIso()))
  })
})
