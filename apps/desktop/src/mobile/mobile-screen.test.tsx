import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      aiProviders: [],
      defaultAiProviderId: null,
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

/** The fake graph: files behind the IPC bridge. */
let files: Record<string, string>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({
  invoke: mockInvoke,
  listen: async () => () => {},
})

afterEach(cleanup)

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

function mount(initialRoute: Route, probeRoute?: Route): ReturnType<typeof render> {
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
    const view = mount({ kind: 'today' })

    // The header is the month; the carousel mounts today's slide (±1
    // neighbours), each carrying its formatted date as the note's subject.
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(monthLabel(today))
    expect(view.getByText(formatDayLabel(today, 'mdy'))).toBeTruthy()
    await waitFor(() => {
      const editors = view.getAllByTestId('fake-editor')
      expect(editors.some((editor) => editor.textContent?.includes('captured on the go'))).toBe(true)
    })
  })

  it('selects a day from the calendar strip and jumps back to today', async () => {
    const user = userEvent.setup()
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = mount({ kind: 'today' })

    expect(view.queryByRole('button', { name: 'Today' })).toBeNull()
    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    expect(view.getByRole('button', { name: dayCellLabel(other) }).getAttribute('aria-current')).toBe(
      'date',
    )
    expect(view.getByRole('button', { name: 'Today' })).toBeTruthy()

    await user.click(view.getByRole('button', { name: 'Today' }))
    expect(view.queryByRole('button', { name: 'Today' })).toBeNull()
    expect(view.getByRole('button', { name: dayCellLabel(today) }).getAttribute('aria-current')).toBe(
      'date',
    )
  })

  it('re-anchors the carousel when a date link lands outside its window', async () => {
    const user = userEvent.setup()
    // Beyond the ±366-day window — only reachable as a date-link navigation,
    // which forces the carousel to rebuild its window around the day.
    const farDay = addDaysIso(todayIso(), 400)
    files[`daily/${farDay}.md`] = 'far future plans'
    const view = mount({ kind: 'today' }, { kind: 'daily', date: farDay })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(monthLabel(farDay))
    await waitFor(() => {
      const editors = view.getAllByTestId('fake-editor')
      expect(editors.some((editor) => editor.textContent?.includes('far future plans'))).toBe(true)
    })
  })

  it('opens a note from in-screen navigation and pops back through history', async () => {
    const user = userEvent.setup()
    files['notes/meeting-notes.md'] = 'agenda'
    const view = mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    expect(view.getByRole('heading').textContent).toContain('meeting-notes')

    await user.click(view.getByRole('button', { name: 'Back' }))
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(monthLabel(todayIso()))
  })

  it('switches tabs: All shows the searchable list, Daily returns to today', async () => {
    const user = userEvent.setup()
    const view = mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: 'All' }))
    expect(view.getByRole('searchbox', { name: 'Search notes' })).toBeTruthy()
    expect((await view.findByText('No notes yet')).textContent).toBe('No notes yet')

    await user.click(view.getByRole('button', { name: 'Daily' }))
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(monthLabel(todayIso()))
  })

  it('renders a search entry as the All tab with the query seeded', async () => {
    const view = mount({ kind: 'search', query: 'meeting' })

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => {
      expect((box as HTMLInputElement).value).toBe('meeting')
    })
    expect(view.getByRole('button', { name: 'All' }).getAttribute('aria-current')).toBe('page')
  })

  it('back from a cold note entry lands on today', async () => {
    const user = userEvent.setup()
    files['notes/meeting-notes.md'] = 'agenda'
    const view = mount({ kind: 'note', path: 'notes/meeting-notes.md' })

    expect(view.getByRole('heading').textContent).toContain('meeting-notes')
    await waitFor(() => {
      expect(view.getByTestId('fake-editor').textContent).toContain('agenda')
    })

    await user.click(view.getByRole('button', { name: 'Back' }))
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(monthLabel(todayIso()))
  })
})
