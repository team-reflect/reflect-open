import type { MaybePromise } from '@reflect/utils'
import { createTestWindowService } from '@reflect/app/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import type { DailyNoteService, NoteRow, RetrievalService } from '@reflect/core'
import {
  createTestCoreServices,
  createTestNoteFileService,
  createTestRetrievalService,
  createTestStorageService,
  type TestNoteFileService,
  type TestStorageService,
} from '@reflect/core/testing'
import { formatDayLabel } from '@/lib/dates.ts'
import { deepLinkForRoute, monthLabel, monthOf } from '@reflect/app'
import { useRouter } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DailyContextSidebar } from './daily-context-sidebar.tsx'

// What the app's fakes answer; each test sets them before `renderSidebar`.
const dailyDatesInRange = vi.fn<DailyNoteService['dailyDatesInRange']>()
const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
let noteRowAnswer: NoteRow | null
let dailySource: string

// The note files of the rendered app; set by `createCore`.
let noteFile: TestNoteFileService

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function sidebar(date: string): ReactNode {
  return (
    <>
      <DailyContextSidebar date={date} />
      <RouteProbe />
    </>
  )
}

function createCore(storage: TestStorageService = createTestStorageService()) {
  noteFile = createTestNoteFileService({ files: { 'daily/2026-06-09.md': dailySource } })
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile,
    storage,
    retrieval: createTestRetrievalService({ relatedNotes }),
  })
  vi.spyOn(core.dailyNotes, 'dailyDatesInRange').mockImplementation(dailyDatesInRange)
  vi.spyOn(core.indexQuery, 'getNote').mockImplementation(() => {
    return Promise.resolve(noteRowAnswer ?? undefined)
  })
  return core
}

async function renderSidebar(date: string, core = createCore()) {
  return await renderInApp(sidebar(date), {
    core,
    appServices: { window: createTestWindowService({ openNoteWindow }) },
    graph: { root: '/g', name: 'g' },
    settings: { semanticSearchEnabled: true, dateFormat: 'mdy', weekStartDay: 'monday' },
  })
}

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'daily/2026-06-09.md',
    title: '2026-06-09',
    dailyDate: '2026-06-09',
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

beforeEach(() => {
  dailyDatesInRange.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
  openNoteWindow.mockReset().mockResolvedValue(true)
  noteRowAnswer = null
  dailySource = '- daily entry\n'
})

describe('DailyContextSidebar calendar header', () => {
  it('jumps to today from the calendar-icon button', async () => {
    await renderSidebar('2026-06-09')
    await userEvent.click(page.getByRole('button', { name: 'Jump to today' }))
    await expect.element(page.getByTestId('route')).toMatchTextContent('"kind":"today"')
  })
})

describe('DailyContextSidebar calendar', () => {
  it('marks days that have a daily note and navigates on day click', async () => {
    dailyDatesInRange.mockResolvedValue(['2026-06-05'])
    await renderSidebar('2026-06-09')

    await expect.element(page.getByTestId('note-dot-2026-06-05')).toBeVisible()
    expect(dailyDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-07-05')
    await expect.element(page.getByTestId('note-dot-2026-06-04')).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') }))
    await expect.element(page.getByTestId('route')).toMatchTextContent('2026-06-18')
  })

  it('modifier-click opens a day in a new window without moving the current window', async () => {
    await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true, ctrlKey: true })

    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'daily',
          date: '2026-06-18',
        }),
      )
    })
    expect(openNoteWindow).toHaveBeenCalledTimes(1)
    await expect
      .element(page.getByTestId('route'))
      .toMatchTextContent(JSON.stringify({ kind: 'today' }))
  })

  it('does not fall back after the calendar scope moves to another selected day', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true, ctrlKey: true })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.rerender(sidebar('2026-06-10'))

    await act(() => {
      pendingOpen.resolve(false)
    })

    await expect
      .element(page.getByTestId('route'))
      .toMatchTextContent(JSON.stringify({ kind: 'today' }))
  })

  it('pages between months across year boundaries', async () => {
    await renderSidebar('2026-01-15')
    await expect.element(page.getByText(monthLabel('2026-01'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Previous month' }))
    await expect.element(page.getByText(monthLabel('2025-12'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await expect.element(page.getByText(monthLabel('2026-02'))).toBeVisible()
  })

  it('re-anchors the visible month when the selected day changes', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel('2026-06'))).toBeVisible()
    await view.rerender(sidebar('2026-09-01'))
    await expect.element(page.getByText(monthLabel('2026-09'))).toBeVisible()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Similar notes section without results', async () => {
    await renderSidebar('2026-06-09')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
  })

  it('does not calculate Similar notes for an empty-bullet daily note', async () => {
    dailySource = '- \n'
    await renderSidebar('2026-06-09')
    await vi.waitFor(() => {
      expect(noteFile.getReads().map((read) => read.path)).toContain('daily/2026-06-09.md')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
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
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Rust')).toBeVisible()
    // The daily sidebar wires SimilarNotesSection (note-context-sidebar's
    // tests pin the same title).
    await expect.element(page.getByText('Similar notes')).toBeVisible()
    await userEvent.click(page.getByText('Rust'))
    await expect.element(page.getByTestId('route')).toMatchTextContent('notes/rust.md')
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    // One session: both mounts read the same storage.
    const storage = createTestStorageService()
    const view = await renderSidebar('2026-06-09', createCore(storage))
    const header = page.getByRole('button', { name: /Note actions/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByText('Pin this note')).toBeVisible()

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(page.getByText('Pin this note')).not.toBeInTheDocument()
    await view.unmount()

    await renderSidebar('2026-06-09', createCore(storage))
    await expect
      .element(page.getByRole('button', { name: /Note actions/ }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('the calendar is not collapsible', async () => {
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel(monthOf('2026-06-09')))).toBeVisible()
    await expect.element(page.getByRole('button', { name: /^Calendar$/ })).not.toBeInTheDocument()
  })
})

describe('DailyContextSidebar published link', () => {
  it('shows the Published URL section once the daily note is published', async () => {
    const url = 'https://gist.github.com/alex/daily1'
    noteRowAnswer = noteRow({ gistUrl: url })
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).toBeVisible()
    await expect.element(page.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('omits the Published URL section for an unpublished daily note', async () => {
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).not.toBeInTheDocument()
  })
})
