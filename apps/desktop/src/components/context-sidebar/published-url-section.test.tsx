import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PublishedUrlSection } from './published-url-section'
import { clearPendingPublishedUrl, setPendingPublishedUrl } from './published-url-bridge'

const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
const operationDone = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: operationDone, fail: operationFail })),
)

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/lib/operations', () => ({ startOperation }))

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

function renderSection(path = 'notes/a.md') {
  return render(
    <TooltipProvider>
      <PublishedUrlSection path={path} />
    </TooltipProvider>,
  )
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

beforeEach(() => {
  window.sessionStorage.clear()
  clearPendingPublishedUrl('notes/a.md', 'https://gist.github.com/alex/g1')
  clearPendingPublishedUrl('notes/a.md', 'https://gist.github.com/alex/pending')
  useNoteRow.mockReset().mockReturnValue(null)
  vi.mocked(openUrl).mockClear()
  startOperation.mockClear()
  operationDone.mockClear()
  operationFail.mockClear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

afterEach(() => {
  cleanup()
})

describe('PublishedUrlSection', () => {
  it('renders nothing for an unpublished note', () => {
    const view = renderSection()
    expect(view.queryByText('Published URL')).toBeNull()
  })

  it('shows the published gist URL for a published note', () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = renderSection()
    expect(view.getByText('Published URL')).toBeTruthy()
    expect(view.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
  })

  it('shows a just-published URL before the index row catches up', () => {
    const url = 'https://gist.github.com/alex/pending'
    setPendingPublishedUrl('notes/a.md', url)

    const view = renderSection()
    expect(view.getByText('Published URL')).toBeTruthy()
    expect(view.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
  })

  it('opens the published URL through the native opener', async () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = renderSection()
    await userEvent.click(view.getByRole('link', { name: url }))
    expect(openUrl).toHaveBeenCalledWith(url)
  })

  it('copies the published URL', async () => {
    const url = 'https://gist.github.com/alex/g1'
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    expect(writeText).toHaveBeenCalledWith(url)
    expect(startOperation).toHaveBeenCalledWith('Published URL copied')
    expect(operationDone).toHaveBeenCalled()
  })

  it('surfaces copy failures through the operations status', async () => {
    const url = 'https://gist.github.com/alex/g1'
    stubClipboard(vi.fn(async () => Promise.reject(new Error('Document is not focused'))))
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    await waitFor(() => expect(startOperation).toHaveBeenCalledWith('Copying the published URL'))
    expect(operationFail).toHaveBeenCalled()
  })
})
