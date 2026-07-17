import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  getNote,
}))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@/lib/note-private', () => ({ toggleNotePrivate }))
vi.mock('@/lib/note-delete', () => ({ deleteOpenNote }))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

function renderSection(path: string, showTrash = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
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
})

function noteRow(path: string, isPrivate: boolean, title = 'A') {
  return { path, title, dailyDate: null, isPrivate }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // jsdom reports a non-Apple platform, so Mod renders as Ctrl.
    expect(button.textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(toggleNotePinned).toHaveBeenCalledWith('notes/a.md', 7)
    view.unmount()
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'journal/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' }])
    const view = renderSection('journal/2026-06-10.md')
    await view.findByText('Un-pin this note')
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(toggleNotePinned).toHaveBeenCalledWith('journal/2026-06-10.md', 7)
    view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    expect(await view.findByText('Un-pin this note')).toBeDefined()
    toggleNotePinned.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(await view.findByText('Pin this note')).toBeDefined()
    expect(toggleNotePinned).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('optimistically adds a newly pinned note after explicitly ordered pins', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/zeta.md', title: 'Zeta', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/alpha.md', title: 'Alpha', dailyDate: null, pinnedOrder: 1 },
    ])
    getNote.mockResolvedValue(noteRow('notes/mid.md', false, 'Mid'))
    const view = renderSection('notes/mid.md')
    const queryKey = pinnedNotesQueryKey('/g')
    await waitFor(() =>
      expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
        'Zeta',
        'Alpha',
      ]),
    )

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))

    expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
      'Zeta',
      'Alpha',
      'Mid',
    ])
    view.unmount()
  })

  it('invalidates pinned notes when an optimistic pin fails', async () => {
    let rejectToggle!: (cause: unknown) => void
    toggleNotePinned.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectToggle = reject
        }),
    )
    const view = renderSection('notes/a.md')
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    expect(view.getByText('Un-pin this note')).toBeDefined()
    rejectToggle({ kind: 'io', message: 'disk on fire' })

    await waitFor(() => expect(view.getByText('Pin this note')).toBeDefined())
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(2))
    expect(startOperation).toHaveBeenCalledWith('Updating pin')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })

})

describe('NoteActionsSection private toggle', () => {
  it('offers Lock note and toggles on click', async () => {
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('notes/a.md', 7)
    view.unmount()
  })

  it('offers Unlock note when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('journal/2026-06-10.md', true))
    const view = renderSection('journal/2026-06-10.md')
    await view.findByText('Unlock note')
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('journal/2026-06-10.md', 7)
    view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(await view.findByText('Unlock note')).toBeDefined()
    toggleNotePrivate.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(await view.findByText('Lock note')).toBeDefined()
    expect(toggleNotePrivate).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('restores the private label when a write fails', async () => {
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await waitFor(() => expect(view.getByText('Lock note')).toBeDefined())
    expect(startOperation).toHaveBeenCalledWith('Updating privacy')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })

})

describe('NoteActionsSection deep-link action', () => {
  it('does not offer Copy deep link in note actions', () => {
    const view = renderSection('notes/a.md')
    expect(view.queryByRole('button', { name: /Copy deep link/ })).toBeNull()
    view.unmount()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', () => {
    const view = renderSection('notes/a.md')
    expect(view.queryByRole('button', { name: 'Trash note' })).toBeNull()
    view.unmount()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    const trashButtons = view.getAllByRole('button', { name: 'Trash note' })
    const confirmButton = trashButtons.at(-1)
    if (confirmButton === undefined) {
      throw new Error('Expected the confirmation button to render')
    }
    await userEvent.click(confirmButton)
    await waitFor(() => expect(deleteOpenNote).toHaveBeenCalledWith('notes/a.md', 7))
    expect(startOperation).toHaveBeenCalledWith('Trashing note')
    view.unmount()
  })

  it('does not offer trash for daily notes even if enabled', () => {
    const view = renderSection('journal/2026-06-10.md', true)
    expect(view.queryByRole('button', { name: 'Trash note' })).toBeNull()
    view.unmount()
  })
})
