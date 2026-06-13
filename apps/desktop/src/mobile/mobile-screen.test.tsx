import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router'
import type { Route } from '@/routing/route'
import { addDaysIso, formatDayLabel, todayIso } from '@/lib/dates'
import { MobileShell } from './mobile-shell'

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
    settings: { editorMarkdownSyntax: 'always', dateFormat: 'mdy' },
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

function dayHeading(date: string): string {
  return formatDayLabel(date, 'mdy')
}

describe('MobileShell', () => {
  it('renders today as the daily spine with its note content', async () => {
    const today = todayIso()
    files[`daily/${today}.md`] = 'captured on the go'
    const view = mount({ kind: 'today' })

    expect(view.getByRole('heading').textContent).toContain(dayHeading(today))
    await waitFor(() => {
      expect(view.getByTestId('fake-editor').textContent).toContain('captured on the go')
    })
  })

  it('pages between days and jumps back to today', async () => {
    const user = userEvent.setup()
    const today = todayIso()
    const yesterday = addDaysIso(today, -1)
    const view = mount({ kind: 'today' })

    expect(view.queryByRole('button', { name: 'Today' })).toBeNull()
    await user.click(view.getByRole('button', { name: 'Previous day' }))
    expect(view.getByRole('heading').textContent).toContain(dayHeading(yesterday))

    await user.click(view.getByRole('button', { name: 'Today' }))
    expect(view.getByRole('heading').textContent).toContain(dayHeading(today))
  })

  it('opens a note from in-screen navigation and pops back through history', async () => {
    const user = userEvent.setup()
    files['notes/meeting-notes.md'] = 'agenda'
    const view = mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    expect(view.getByRole('heading').textContent).toContain('meeting-notes')

    await user.click(view.getByRole('button', { name: 'Back' }))
    expect(view.getByRole('heading').textContent).toContain(dayHeading(todayIso()))
  })

  it('switches tabs: All shows the searchable list, Daily returns to today', async () => {
    const user = userEvent.setup()
    const view = mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: 'All' }))
    expect(view.getByRole('searchbox', { name: 'Search notes' })).toBeTruthy()
    expect((await view.findByText('No notes yet')).textContent).toBe('No notes yet')

    await user.click(view.getByRole('button', { name: 'Daily' }))
    expect(view.getByRole('heading').textContent).toContain(dayHeading(todayIso()))
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
    expect(view.getByRole('heading').textContent).toContain(dayHeading(todayIso()))
  })
})
