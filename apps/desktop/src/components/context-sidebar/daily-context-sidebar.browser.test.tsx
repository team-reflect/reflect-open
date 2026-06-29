import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import type { NoteRow } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { formatDayLabel } from '@/lib/dates'
import { monthLabel, monthOf } from '@/lib/month-grid'
import { RouterProvider, useRouter } from '@/routing/router'
import { DailyContextSidebar } from './daily-context-sidebar'

const dailyDatesInRange = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  dailyDatesInRange,
  relatedNotes,
}))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: true, dateFormat: 'mdy', weekStartDay: 'monday' },
    updateSettings: () => {},
  }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSidebar(date: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider>
          <DailyContextSidebar date={date} />
          <RouteProbe />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'daily/2026-06-09.md',
    title: '2026-06-09',
    dailyDate: '2026-06-09',
    isPrivate: false,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

beforeEach(() => {
  window.sessionStorage.clear()
  dailyDatesInRange.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
  useNoteRow.mockReset().mockReturnValue(null)
})

describe('DailyContextSidebar calendar header', () => {
  it('jumps to today from the calendar-icon button', async () => {
    const view = await renderSidebar('2026-06-09')
    await userEvent.click(view.getByRole('button', { name: 'Jump to today' }))
    await expect.element(view.getByTestId('route')).toHaveTextContent('"kind":"today"')
  })
})

describe('DailyContextSidebar calendar', () => {
  it('marks days that have a daily note and navigates on day click', async () => {
    dailyDatesInRange.mockResolvedValue(['2026-06-05'])
    const view = await renderSidebar('2026-06-09')

    await expect.element(view.getByTestId('note-dot-2026-06-05')).toBeInTheDocument()
    expect(dailyDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-07-05')
    await expect.element(view.getByTestId('note-dot-2026-06-04')).not.toBeInTheDocument()

    await userEvent.click(view.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') }))
    await expect.element(view.getByTestId('route')).toHaveTextContent('2026-06-18')
  })

  it('pages between months across year boundaries', async () => {
    const view = await renderSidebar('2026-01-15')
    await expect.element(view.getByText(monthLabel('2026-01'))).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Previous month' }))
    await expect.element(view.getByText(monthLabel('2025-12'))).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Next month' }))
    await userEvent.click(view.getByRole('button', { name: 'Next month' }))
    await expect.element(view.getByText(monthLabel('2026-02'))).toBeInTheDocument()
  })

  it('re-anchors the visible month when the selected day changes', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(view.getByText(monthLabel('2026-06'))).toBeInTheDocument()
    await view.rerender(
      <TooltipProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <RouterProvider>
            <DailyContextSidebar date="2026-09-01" />
            <RouteProbe />
          </RouterProvider>
        </QueryClientProvider>
      </TooltipProvider>,
    )
    await expect.element(view.getByText(monthLabel('2026-09'))).toBeInTheDocument()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Similar notes section without results', async () => {
    const view = await renderSidebar('2026-06-09')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    await expect.element(view.getByText('Similar notes')).not.toBeInTheDocument()
  })

  it('lists semantic neighbors when they exist', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSidebar('2026-06-09')
    await expect.element(view.getByText('Rust')).toBeInTheDocument()
    // The daily sidebar wires SimilarNotesSection (note-context-sidebar's
    // tests pin the same title).
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Rust'))
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/rust.md')
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    const view = await renderSidebar('2026-06-09')
    const header = view.getByRole('button', { name: /Note actions/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByText('Pin this note')).toBeInTheDocument()

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Pin this note')).not.toBeInTheDocument()
    await view.unmount()

    const reopened = await renderSidebar('2026-06-09')
    await expect
      .element(reopened.getByRole('button', { name: /Note actions/ }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('the calendar is not collapsible', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(view.getByText(monthLabel(monthOf('2026-06-09')))).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /^Calendar$/ })).not.toBeInTheDocument()
  })
})

describe('DailyContextSidebar published link', () => {
  it('shows the Published URL section once the daily note is published', async () => {
    const url = 'https://gist.github.com/alex/daily1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))
    const view = await renderSidebar('2026-06-09')
    await expect.element(view.getByText('Published URL')).toBeInTheDocument()
    await expect.element(view.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('omits the Published URL section for an unpublished daily note', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(view.getByText('Published URL')).not.toBeInTheDocument()
  })
})
