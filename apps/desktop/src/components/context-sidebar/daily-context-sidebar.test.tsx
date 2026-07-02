import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { NoteRow } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { formatDayLabel } from '@/lib/dates'
import { monthLabel, monthOf } from '@/lib/month-grid'
import { RouterProvider, useRouter } from '@/routing/router'
import { DailyContextSidebar } from './daily-context-sidebar'

const dailyDatesInRange = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
const readNote = vi.hoisted(() => vi.fn())
const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  dailyDatesInRange,
  readNote,
  relatedNotes,
}))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
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
  readNote.mockReset().mockResolvedValue('- daily entry\n')
  relatedNotes.mockReset().mockResolvedValue([])
  useNoteRow.mockReset().mockReturnValue(null)
})

afterEach(cleanup)

describe('DailyContextSidebar calendar header', () => {
  it('jumps to today from the calendar-icon button', async () => {
    const view = renderSidebar('2026-06-09')
    await userEvent.click(view.getByRole('button', { name: 'Jump to today' }))
    expect(view.getByTestId('route').textContent).toContain('"kind":"today"')
    view.unmount()
  })
})

describe('DailyContextSidebar calendar', () => {
  it('marks days that have a daily note and navigates on day click', async () => {
    dailyDatesInRange.mockResolvedValue(['2026-06-05'])
    const view = renderSidebar('2026-06-09')

    await view.findByTestId('note-dot-2026-06-05')
    expect(dailyDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-07-05')
    expect(view.queryByTestId('note-dot-2026-06-04')).toBeNull()

    await userEvent.click(view.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') }))
    expect(view.getByTestId('route').textContent).toContain('2026-06-18')
    view.unmount()
  })

  it('pages between months across year boundaries', async () => {
    const view = renderSidebar('2026-01-15')
    expect(view.getByText(monthLabel('2026-01'))).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Previous month' }))
    expect(view.getByText(monthLabel('2025-12'))).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Next month' }))
    await userEvent.click(view.getByRole('button', { name: 'Next month' }))
    expect(view.getByText(monthLabel('2026-02'))).toBeDefined()
    view.unmount()
  })

  it('re-anchors the visible month when the selected day changes', () => {
    const view = renderSidebar('2026-06-09')
    expect(view.getByText(monthLabel('2026-06'))).toBeDefined()
    view.rerender(
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
    expect(view.getByText(monthLabel('2026-09'))).toBeDefined()
    view.unmount()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Similar notes section without results', async () => {
    const view = renderSidebar('2026-06-09')
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    expect(view.queryByText('Similar notes')).toBeNull()
    view.unmount()
  })

  it('does not calculate Similar notes for an empty-bullet daily note', async () => {
    readNote.mockResolvedValue('- \n')
    const view = renderSidebar('2026-06-09')
    await waitFor(() => expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(view.queryByText('Similar notes')).toBeNull()
    view.unmount()
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
    const view = renderSidebar('2026-06-09')
    await view.findByText('Rust')
    // The daily sidebar wires SimilarNotesSection (note-context-sidebar's
    // tests pin the same title).
    expect(view.getByText('Similar notes')).toBeDefined()
    await userEvent.click(view.getByText('Rust'))
    expect(view.getByTestId('route').textContent).toContain('notes/rust.md')
    view.unmount()
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    const view = renderSidebar('2026-06-09')
    const header = view.getByRole('button', { name: /Note actions/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('Pin this note')).toBeDefined()

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('Pin this note')).toBeNull()
    view.unmount()

    const reopened = renderSidebar('2026-06-09')
    expect(
      reopened.getByRole('button', { name: /Note actions/ }).getAttribute('aria-expanded'),
    ).toBe('false')
    reopened.unmount()
  })

  it('the calendar is not collapsible', () => {
    const view = renderSidebar('2026-06-09')
    expect(view.getByText(monthLabel(monthOf('2026-06-09')))).toBeDefined()
    expect(view.queryByRole('button', { name: /^Calendar$/ })).toBeNull()
    view.unmount()
  })
})

describe('DailyContextSidebar published link', () => {
  it('shows the Published URL section once the daily note is published', () => {
    const url = 'https://gist.github.com/alex/daily1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))
    const view = renderSidebar('2026-06-09')
    expect(view.getByText('Published URL')).toBeDefined()
    expect(view.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
    view.unmount()
  })

  it('omits the Published URL section for an unpublished daily note', () => {
    const view = renderSidebar('2026-06-09')
    expect(view.queryByText('Published URL')).toBeNull()
    view.unmount()
  })
})
