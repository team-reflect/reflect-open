import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { NoteRow } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { formatDayLabel } from '@/lib/dates'
import { monthLabel, monthOf } from '@/lib/month-grid'
import type { NoteRoute } from '@/routing/route'
import { RouterProvider, useRouter } from '@/routing/router'
import { fireEvent } from '@/test-utils/fire-event'
import '@/test-utils/locator'
import { DailyContextSidebar } from './daily-context-sidebar'

const dailyDatesInRange = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
const readNote = vi.hoisted(() => vi.fn())
const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
const openRouteInNewWindow = vi.hoisted(() =>
  vi.fn<(route: NoteRoute) => Promise<boolean>>(),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  dailyDatesInRange,
  readNote,
  relatedNotes,
}))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
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
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

afterEach(async () => {
  await cleanup()
})

describe('DailyContextSidebar calendar header', () => {
  it('jumps to today from the calendar-icon button', async () => {
    const view = await renderSidebar('2026-06-09')
    await userEvent.click(page.getByRole('button', { name: 'Jump to today' }))
    await expect.element(page.getByTestId('route')).toHaveTextContent('"kind":"today"')
    await view.unmount()
  })
})

describe('DailyContextSidebar calendar', () => {
  it('marks days that have a daily note and navigates on day click', async () => {
    dailyDatesInRange.mockResolvedValue(['2026-06-05'])
    const view = await renderSidebar('2026-06-09')

    await expect.element(page.getByTestId('note-dot-2026-06-05')).toBeVisible()
    expect(dailyDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-07-05')
    await expect.element(page.getByTestId('note-dot-2026-06-04')).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') }))
    await expect.element(page.getByTestId('route')).toHaveTextContent('2026-06-18')
    await view.unmount()
  })

  it('modifier-click opens a day in a new window without moving the current window', async () => {
    const view = await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'daily',
        date: '2026-06-18',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent(JSON.stringify({ kind: 'today' }))
    await view.unmount()
  })

  it('does not fall back after the calendar scope moves to another selected day', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.rerender(
      <TooltipProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <RouterProvider>
            <DailyContextSidebar date="2026-06-10" />
            <RouteProbe />
          </RouterProvider>
        </QueryClientProvider>
      </TooltipProvider>,
    )

    await act(async () => {
      finishOpen(false)
    })

    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent(JSON.stringify({ kind: 'today' }))
    await view.unmount()
  })

  it('pages between months across year boundaries', async () => {
    const view = await renderSidebar('2026-01-15')
    await expect.element(page.getByText(monthLabel('2026-01'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Previous month' }))
    await expect.element(page.getByText(monthLabel('2025-12'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await expect.element(page.getByText(monthLabel('2026-02'))).toBeVisible()
    await view.unmount()
  })

  it('re-anchors the visible month when the selected day changes', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel('2026-06'))).toBeVisible()
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
    await expect.element(page.getByText(monthLabel('2026-09'))).toBeVisible()
    await view.unmount()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Similar notes section without results', async () => {
    const view = await renderSidebar('2026-06-09')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
    await view.unmount()
  })

  it('does not calculate Similar notes for an empty-bullet daily note', async () => {
    readNote.mockResolvedValue('- \n')
    const view = await renderSidebar('2026-06-09')
    await vi.waitFor(() => expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
    await view.unmount()
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
    await expect.element(page.getByText('Rust')).toBeVisible()
    // The daily sidebar wires SimilarNotesSection (note-context-sidebar's
    // tests pin the same title).
    await expect.element(page.getByText('Similar notes')).toBeVisible()
    await userEvent.click(page.getByText('Rust'))
    await expect.element(page.getByTestId('route')).toHaveTextContent('notes/rust.md')
    await view.unmount()
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    const view = await renderSidebar('2026-06-09')
    const header = page.getByRole('button', { name: /Note actions/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByText('Pin this note')).toBeVisible()

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(page.getByText('Pin this note')).not.toBeInTheDocument()
    await view.unmount()

    const reopened = await renderSidebar('2026-06-09')
    await expect
      .element(page.getByRole('button', { name: /Note actions/ }))
      .toHaveAttribute('aria-expanded', 'false')
    await reopened.unmount()
  })

  it('the calendar is not collapsible', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel(monthOf('2026-06-09')))).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /^Calendar$/ }))
      .not.toBeInTheDocument()
    await view.unmount()
  })
})

describe('DailyContextSidebar published link', () => {
  it('shows the Published URL section once the daily note is published', async () => {
    const url = 'https://gist.github.com/alex/daily1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).toBeVisible()
    await expect.element(page.getByRole('link', { name: url })).toHaveAttribute('href', url)
    await view.unmount()
  })

  it('omits the Published URL section for an unpublished daily note', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).not.toBeInTheDocument()
    await view.unmount()
  })
})
