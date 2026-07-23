import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { pinnedNotesQueryKey } from '@/hooks/use-pinned-notes'
import { RouterProvider } from '@/routing/router'
import { NoteActionsSection } from './note-actions-section'

const getPinnedNotes = vi.hoisted(() => vi.fn())
const getNote = vi.hoisted(() => vi.fn())
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
const toggleNotePrivate = vi.hoisted(() => vi.fn(async () => true))
const deleteOpenNote = vi.hoisted(() => vi.fn(async () => {}))
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: vi.fn(), fail: operationFail })),
)
const isApplePlatform = vi.hoisted(() => vi.fn(() => false))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  getNote,
}))
vi.mock('@/lib/keybindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keybindings')>()),
  isApplePlatform,
}))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@/lib/note-private', () => ({ toggleNotePrivate }))
vi.mock('@/lib/note-delete', () => ({ deleteOpenNote }))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

async function renderSection(path: string, showTrash = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider initialRoute={{ kind: 'note', path }}>
          <NoteActionsSection path={path} showTrash={showTrash} />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
  return { ...view, client }
}

beforeEach(() => {
  window.sessionStorage.clear()
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(undefined)
  toggleNotePinned.mockReset().mockResolvedValue(true)
  toggleNotePrivate.mockReset().mockResolvedValue(true)
  deleteOpenNote.mockReset().mockResolvedValue(undefined)
  startOperation.mockClear()
  operationFail.mockClear()
  isApplePlatform.mockReturnValue(false)
})

function noteRow(path: string, isPrivate: boolean, title = 'A') {
  return { path, title, dailyDate: null, isPrivate }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // The mocked platform is non-Apple, so Mod renders as Ctrl.
    expect(button.element().textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(toggleNotePinned).toHaveBeenCalledWith('notes/a.md', 7)
    await view.unmount()
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' }])
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(toggleNotePinned).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
    await view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    toggleNotePinned.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(toggleNotePinned).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('optimistically adds a newly pinned note after explicitly ordered pins', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/zeta.md', title: 'Zeta', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/alpha.md', title: 'Alpha', dailyDate: null, pinnedOrder: 1 },
    ])
    getNote.mockResolvedValue(noteRow('notes/mid.md', false, 'Mid'))
    const view = await renderSection('notes/mid.md')
    const queryKey = pinnedNotesQueryKey('/g')
    await vi.waitFor(() =>
      expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
        'Zeta',
        'Alpha',
      ]),
    )

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))

    await vi.waitFor(() =>
      expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
        'Zeta',
        'Alpha',
        'Mid',
      ]),
    )
    await view.unmount()
  })

  it('invalidates pinned notes when an optimistic pin fails', async () => {
    let rejectToggle!: (cause: unknown) => void
    toggleNotePinned.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectToggle = reject
        }),
    )
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    rejectToggle({ kind: 'io', message: 'disk on fire' })

    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(2))
    expect(startOperation).toHaveBeenCalledWith('Updating pin')
    expect(operationFail).toHaveBeenCalled()
    await view.unmount()
  })

})

describe('NoteActionsSection private toggle', () => {
  it('offers Lock note and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('notes/a.md', 7)
    await view.unmount()
  })

  it('offers Unlock note when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
    await view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    toggleNotePrivate.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    await expect.element(view.getByText('Lock note', { exact: true })).toBeInTheDocument()
    expect(toggleNotePrivate).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('restores the private label when a write fails', async () => {
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await expect.element(view.getByText('Lock note', { exact: true })).toBeInTheDocument()
    expect(startOperation).toHaveBeenCalledWith('Updating privacy')
    expect(operationFail).toHaveBeenCalled()
    await view.unmount()
  })

})

describe('NoteActionsSection deep-link action', () => {
  it('does not offer Copy deep link in note actions', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: /Copy deep link/ }).query()).toBeNull()
    await view.unmount()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
    await view.unmount()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = await renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    const confirmButton = page.getByRole('dialog').getByRole('button', { name: 'Trash note' })
    await userEvent.click(confirmButton)
    await vi.waitFor(() => expect(deleteOpenNote).toHaveBeenCalledWith('notes/a.md', 7))
    expect(startOperation).toHaveBeenCalledWith('Trashing note')
    await view.unmount()
  })

  it('does not offer trash for daily notes even if enabled', async () => {
    const view = await renderSection('daily/2026-06-10.md', true)
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
    await view.unmount()
  })
})
