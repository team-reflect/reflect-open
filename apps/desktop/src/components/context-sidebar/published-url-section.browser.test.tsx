import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { NoteRow } from '@reflect/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PublishedUrlSection } from './published-url-section'

const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
const operationDone = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: operationDone, fail: operationFail })),
)
const runGistPublish = vi.hoisted(() =>
  vi.fn<(path: string, generation: number) => Promise<string | null>>(
    async () => 'https://gist.github.com/alex/g1',
  ),
)

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/lib/note-gist', () => ({ runGistPublish }))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 7 } }),
}))

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
  useNoteRow.mockReset().mockReturnValue(null)
  vi.mocked(openUrl).mockClear()
  startOperation.mockClear()
  runGistPublish.mockReset().mockResolvedValue('https://gist.github.com/alex/g1')
  operationDone.mockClear()
  operationFail.mockClear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('PublishedUrlSection', () => {
  it('renders nothing for an unpublished note', async () => {
    const view = await renderSection()
    await expect.element(view.getByText('Published URL')).not.toBeInTheDocument()
  })

  it('shows the published gist URL for a published note', async () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = await renderSection()
    await expect.element(view.getByText('Published URL')).toBeInTheDocument()
    await expect.element(view.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('opens the published URL through the native opener', async () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = await renderSection()
    await userEvent.click(view.getByRole('link', { name: url }))
    expect(openUrl).toHaveBeenCalledWith(url)
  })

  it('copies the published URL', async () => {
    const url = 'https://gist.github.com/alex/g1'
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    expect(writeText).toHaveBeenCalledWith(url)
    expect(startOperation).toHaveBeenCalledWith('Published URL copied')
    expect(operationDone).toHaveBeenCalled()
  })

  it('updates the published gist from the URL section icon', async () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Update published gist' }))

    expect(runGistPublish).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('shows the stale update affordance beside the copy button', async () => {
    const url = 'https://gist.github.com/alex/g1'
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url, gistStale: true }))

    const view = await renderSection()
    await expect.element(view.getByRole('button', { name: 'Copy published URL' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Update published gist' })).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Update published gist' }).element().className).toContain('text-accent')
  })

  it('surfaces copy failures through the operations status', async () => {
    const url = 'https://gist.github.com/alex/g1'
    stubClipboard(vi.fn(async () => Promise.reject(new Error('Document is not focused'))))
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url }))

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    await vi.waitFor(() => expect(startOperation).toHaveBeenCalledWith('Copying the published URL'))
    expect(operationFail).toHaveBeenCalled()
  })
})
