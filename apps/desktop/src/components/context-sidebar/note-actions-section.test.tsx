import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NoteActionsSection } from './note-actions-section'

const getPinnedNotes = vi.hoisted(() => vi.fn())
const getNote = vi.hoisted(() => vi.fn())
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
const toggleNotePrivate = vi.hoisted(() => vi.fn(async () => true))
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
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 7 } }),
}))

function renderSection(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <NoteActionsSection path={path} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(undefined)
  toggleNotePinned.mockReset().mockResolvedValue(true)
  toggleNotePrivate.mockReset().mockResolvedValue(true)
  startOperation.mockClear()
  operationFail.mockClear()
})

function noteRow(path: string, isPrivate: boolean) {
  return { path, title: 'A', dailyDate: null, isPrivate }
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
    getPinnedNotes.mockResolvedValue([{ path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' }])
    const view = renderSection('daily/2026-06-10.md')
    await view.findByText('Un-pin this note')
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(toggleNotePinned).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
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

  it('stays on Pin this note when a different note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/other.md', title: 'Other', dailyDate: null }])
    const view = renderSection('notes/a.md')
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.getByText('Pin this note')).toBeDefined()
    expect(view.queryByText('Un-pin this note')).toBeNull()
    view.unmount()
  })

  it('surfaces a toggle failure through the operations status', async () => {
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Pinning note')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })

  it('labels a failed unpin as unpinning', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/a.md', title: 'A', dailyDate: null }])
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(await view.findByRole('button', { name: /Un-pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Unpinning note')
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
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    const view = renderSection('daily/2026-06-10.md')
    await view.findByText('Unlock note')
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
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

  it('stays on Lock note for a note the index reports as not private', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', false))
    const view = renderSection('notes/a.md')
    await waitFor(() => expect(getNote).toHaveBeenCalled())
    expect(view.getByText('Lock note')).toBeDefined()
    expect(view.queryByText('Unlock note')).toBeNull()
    view.unmount()
  })

  it('surfaces a toggle failure through the operations status', async () => {
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(startOperation).toHaveBeenCalledWith('Locking note')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })

  it('labels a failed un-mark as un-marking', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(await view.findByRole('button', { name: /Unlock note/ }))
    expect(startOperation).toHaveBeenCalledWith('Unlocking note')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })
})
