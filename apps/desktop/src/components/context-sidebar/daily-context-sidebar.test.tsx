import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { addDaysIso, formatDayLabel, todayIso } from '@/lib/dates'
import { monthLabel, monthOf, addMonths } from '@/lib/month-grid'
import { RouterProvider, useRouter } from '@/routing/router'
import { DailyContextSidebar } from './daily-context-sidebar'

const dailyDatesInRange = vi.hoisted(() => vi.fn())
const getBacklinksWithContext = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  dailyDatesInRange,
  getBacklinksWithContext,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSidebar(date: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <DailyContextSidebar date={date} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  dailyDatesInRange.mockReset().mockResolvedValue([])
  getBacklinksWithContext.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('DailyContextSidebar header', () => {
  it('shows the day label and a Today badge on today', async () => {
    const today = todayIso()
    const view = renderSidebar(today)
    expect(view.getByRole('heading', { name: formatDayLabel(today) })).toBeDefined()
    expect(view.getByText('Today')).toBeDefined()
    expect(view.queryByText('Go to today')).toBeNull()
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    view.unmount()
  })

  it('offers "Go to today" with the real platform-formatted hint on other days', async () => {
    const past = addDaysIso(todayIso(), -3)
    const view = renderSidebar(past)
    const goToToday = view.getByRole('button', { name: /Go to today/ })
    // jsdom reports a non-Apple platform, so Mod renders as Ctrl.
    expect(goToToday.textContent).toContain('Ctrl+D')
    await userEvent.click(goToToday)
    expect(view.getByTestId('route').textContent).toContain('"kind":"today"')
    view.unmount()
  })

  it('navigates to adjacent days', async () => {
    const date = '2026-06-09'
    const view = renderSidebar(date)
    await userEvent.click(view.getByRole('button', { name: 'Previous day' }))
    expect(view.getByTestId('route').textContent).toContain('2026-06-08')
    await userEvent.click(view.getByRole('button', { name: 'Next day' }))
    expect(view.getByTestId('route').textContent).toContain('2026-06-10')
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

    await userEvent.click(view.getByRole('button', { name: formatDayLabel('2026-06-18') }))
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
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider>
          <DailyContextSidebar date="2026-09-01" />
          <RouteProbe />
        </RouterProvider>
      </QueryClientProvider>,
    )
    expect(view.getByText(monthLabel('2026-09'))).toBeDefined()
    view.unmount()
  })
})

describe('DailyContextSidebar backlinks', () => {
  it('shows a quiet empty state when nothing links to the day', async () => {
    const view = renderSidebar('2026-06-09')
    await view.findByText('No notes link to this day yet.')
    expect(getBacklinksWithContext).toHaveBeenCalledWith('daily/2026-06-09.md')
    view.unmount()
  })

  it('lists inbound links with snippets and navigates on click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/standup.md',
        sourceTitle: 'Standup',
        snippet: 'review on [[2026-06-09]]',
        posFrom: 4,
      },
    ])
    const view = renderSidebar('2026-06-09')
    await view.findByText('Standup')
    expect(view.getByText('review on [[2026-06-09]]')).toBeDefined()
    await userEvent.click(view.getByText('Standup'))
    expect(view.getByTestId('route').textContent).toContain('notes/standup.md')
    view.unmount()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Related section without results', async () => {
    const view = renderSidebar('2026-06-09')
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md'))
    expect(view.queryByText('Related')).toBeNull()
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
      },
    ])
    const view = renderSidebar('2026-06-09')
    await view.findByText('Rust')
    expect(view.getByText('Related')).toBeDefined()
    await userEvent.click(view.getByText('Rust'))
    expect(view.getByTestId('route').textContent).toContain('notes/rust.md')
    view.unmount()
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    const view = renderSidebar('2026-06-09')
    const header = view.getByRole('button', { name: /Calendar/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(monthLabel(monthOf('2026-06-09')))).toBeDefined()

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(monthLabel(addMonths(monthOf('2026-06-09'), 0)))).toBeNull()
    view.unmount()

    const reopened = renderSidebar('2026-06-09')
    expect(
      reopened.getByRole('button', { name: /Calendar/ }).getAttribute('aria-expanded'),
    ).toBe('false')
    reopened.unmount()
  })
})
